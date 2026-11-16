#!/usr/bin/env node
/* cadence.js — how often the company wakes: the dispatcher tick, each seat's loop schedule, cooldown and priority.
 *
 *   node company/tools/cadence.js show [--json]
 *   node company/tools/cadence.js set-default <minutes> --by <name> [--cooldown <min>] [--max-per-tick N]
 *   node company/tools/cadence.js set <seatId> [--loop-every <cron-or-minutes>] [--cooldown <min>] [--priority N]
 *                                  [--wake-on-inbox on|off] [--wake-on-owner on|off] --by <name>
 *   node company/tools/cadence.js apply [--dry-run] [--approved-ref <questionId>] [--by <name>]
 *   node company/tools/cadence.js selftest
 *
 * Source of truth: company/work/ops/cadence.json (defaults: company/defaults/work/ops/cadence.json), merged with the
 * per-seat fields already in loops.json (cooldownMin, priority, wakeOnInbox, wakeOnOwnerMessage); a value set in
 * cadence.json wins. `set` and `set-default` only edit cadence.json. `apply` makes it true:
 *   - writes the per-seat fields into loops.json (dispatch.js reads them from there);
 *   - for a seat with loopEvery, updates its loop routine's schedule (POST /api/cron/update {id, patch:{schedule}}),
 *     only when the station's schedule differs;
 *   - rewrites OnUnitActiveSec in ~/.config/systemd/user/<serviceName>-dispatch.timer. It never runs systemctl: it
 *     prints the reload line for the caller.
 * dispatch.js reads defaultCooldownMin and maxPerTick from cadence.json directly (env vars still override), so those
 * two need no apply. Governance: category 'schedules' (co.gate). At 'approve', apply refuses without
 * --approved-ref <questionId> (ask the owner first with company/tools/inbox.js ask); at 'notify' it applies and tells
 * the owner.
 * loopEvery is minutes (30 => "every 30m"), "every Nm" / "every Nh", or a 5-field cron ("0 9 * * 1-5"), so the
 * station's stored schedule can be compared exactly.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const co = require('./lib/company');

const BUILTIN = { dispatcherTickMin: 10, defaultCooldownMin: 40, maxPerTick: 4, seats: {} };
const SEAT_FIELDS = ['cooldownMin', 'priority', 'wakeOnInbox', 'wakeOnOwnerMessage'];
const S = {
  file: co.p('company', 'work', 'ops', 'cadence.json'),
  defaultFile: co.p('company', 'defaults', 'work', 'ops', 'cadence.json'),
  loopsFile: co.LOOPS_FILE,
  unitDir: process.env.CADENCE_UNIT_DIR || path.join(os.homedir(), '.config', 'systemd', 'user'),
  service: () => (co.config.station && co.config.station.serviceName) || 'capheos-station',
  call: (method, p, body) => require('./station-crew.js').call(method, p, body, 20000),
  gate: () => co.gate('schedules'),
  governance: () => { try { return require('./lib/governance'); } catch (_) { return null; } },
  notify: text => require('./owner-inbox.js').send({ from: co.nameOf(co.ceo()), text }),
  now: () => Date.now(),
};

function load() {
  const c = co.readJson(S.file, null) || co.readJson(S.defaultFile, null) || {};
  return Object.assign({}, BUILTIN, c, { seats: Object.assign({}, (c && c.seats) || {}) });
}
function save(c) {
  fs.mkdirSync(path.dirname(S.file), { recursive: true });
  const tmp = S.file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n');
  fs.renameSync(tmp, S.file);
}
function loops() { return co.readJson(S.loopsFile, {}) || {}; }
const posInt = (v, what) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new Error(what + ' must be a whole number >= 1 (got ' + v + ')'); return n; };
const onOff = (v, what) => { if (v === 'on' || v === true) return true; if (v === 'off') return false; throw new Error(what + ' must be on or off'); };

/* loopEvery -> {kind:'interval', minutes, text} | {kind:'cron', expr, text}. Throws on anything else. */
function parseEvery(v) {
  const s = String(v == null ? '' : v).trim();
  if (/^\d+$/.test(s)) { const m = posInt(s, 'loop-every'); return { kind: 'interval', minutes: m, text: 'every ' + m + 'm' }; }
  let m = s.match(/^every\s+(\d+)\s*(m|min|minutes?|h|hours?)$/i);
  if (m) { const n = posInt(m[1], 'loop-every') * (/^h/i.test(m[2]) ? 60 : 1); return { kind: 'interval', minutes: n, text: 'every ' + n + 'm' }; }
  const parts = s.split(/\s+/);
  if (parts.length === 5 && parts.every(p => /^[\d*,\-/]+$/.test(p))) return { kind: 'cron', expr: parts.join(' '), text: parts.join(' ') };
  throw new Error('loop-every must be minutes, "every Nm"/"every Nh" or a 5-field cron (got "' + s + '")');
}
function sameSchedule(want, cur) {
  if (!cur || !want) return false;
  if (want.kind === 'interval') return cur.kind === 'interval' && Number(cur.minutes) === want.minutes;
  return cur.kind === 'cron' && String(cur.expr || '').trim().split(/\s+/).join(' ') === want.expr;
}

/* The merged view: what each seat runs on, and where each value comes from. */
function view() {
  const c = load(); const L = loops(); const agents = L.agents || {};
  const seats = {};
  for (const [id, row] of Object.entries(agents)) {
    const set = c.seats[id] || {};
    const v = { name: row.name || id, loop: row.loop || null };
    for (const f of SEAT_FIELDS) {
      if (set[f] !== undefined) v[f] = { value: set[f], from: 'cadence' };
      else if (row[f] !== undefined) v[f] = { value: row[f], from: 'loops' };
      else if (f === 'cooldownMin') v[f] = { value: c.defaultCooldownMin, from: 'default' };
    }
    if (set.loopEvery !== undefined) v.loopEvery = set.loopEvery;
    seats[id] = v;
  }
  const unknown = Object.keys(c.seats).filter(id => !agents[id]);
  return { dispatcherTickMin: c.dispatcherTickMin, defaultCooldownMin: c.defaultCooldownMin, maxPerTick: c.maxPerTick, seats, unknownSeats: unknown,
    file: path.relative(co.ROOT, fs.existsSync(S.file) ? S.file : S.defaultFile) };
}
function record(c, by, what) {
  c.changes = (c.changes || []).concat([{ at: new Date(S.now()).toISOString(), by, what }]).slice(-50);
}
function setDefault(minutes, { by, cooldown, maxPerTick } = {}) {
  if (!by) throw new Error('--by <name> is required');
  const c = load(); const what = [];
  if (minutes != null) { c.dispatcherTickMin = posInt(minutes, 'dispatcher tick minutes'); what.push('dispatcherTickMin=' + c.dispatcherTickMin); }
  if (cooldown != null) { c.defaultCooldownMin = posInt(cooldown, 'cooldown'); what.push('defaultCooldownMin=' + c.defaultCooldownMin); }
  if (maxPerTick != null) { c.maxPerTick = posInt(maxPerTick, 'max-per-tick'); what.push('maxPerTick=' + c.maxPerTick); }
  if (!what.length) throw new Error('nothing to set');
  record(c, by, what.join(', ')); save(c);
  return { ok: true, set: what, next: 'node company/tools/cadence.js apply' };
}
function setSeat(seatId, o = {}) {
  if (!o.by) throw new Error('--by <name> is required');
  if (!seatId || !(loops().agents || {})[seatId]) throw new Error('no seat "' + seatId + '" in loops.json');
  const c = load(); const s = Object.assign({}, c.seats[seatId] || {}); const what = [];
  if (o.loopEvery != null) { s.loopEvery = parseEvery(o.loopEvery).text; what.push('loopEvery=' + s.loopEvery); }
  if (o.cooldown != null) { s.cooldownMin = posInt(o.cooldown, 'cooldown'); what.push('cooldownMin=' + s.cooldownMin); }
  if (o.priority != null) { const n = Number(o.priority); if (!Number.isFinite(n)) throw new Error('priority must be a number'); s.priority = n; what.push('priority=' + n); }
  if (o.wakeOnInbox != null) { s.wakeOnInbox = onOff(o.wakeOnInbox, 'wake-on-inbox'); what.push('wakeOnInbox=' + s.wakeOnInbox); }
  if (o.wakeOnOwner != null) { s.wakeOnOwnerMessage = onOff(o.wakeOnOwner, 'wake-on-owner'); what.push('wakeOnOwnerMessage=' + s.wakeOnOwnerMessage); }
  if (!what.length) throw new Error('nothing to set');
  c.seats[seatId] = s; record(c, o.by, seatId + ': ' + what.join(', ')); save(c);
  return { ok: true, seat: seatId, set: what, next: 'node company/tools/cadence.js apply' };
}

function timerPath() { return path.join(S.unitDir, S.service() + '-dispatch.timer'); }
function timerPlan(tickMin) {
  const f = timerPath();
  let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch (_) { return { file: f, missing: true }; }
  const next = txt.replace(/^OnUnitActiveSec=.*$/m, 'OnUnitActiveSec=' + tickMin + 'min')
    .replace(/^(Description=.*?every )\d+ minutes?/m, '$1' + tickMin + ' minutes');
  return { file: f, changed: next !== txt, text: next };
}

async function apply({ dry, approvedRef, by } = {}) {
  const level = S.gate();
  if (level === 'approve') {
    if (!approvedRef) {
      return { ok: false, refused: true, gate: 'approve',
        error: 'schedules are at governance level "approve": ask the owner first, e.g. `node company/tools/inbox.js ask --from <you> --about cadence --q "May we change the company cadence to <what>?"`, then rerun with --approved-ref <questionId> once answered yes' };
    }
    const gov = S.governance();
    if (gov && typeof gov.verifyApproval === 'function') {
      const v = await gov.verifyApproval('schedules', approvedRef);
      if (!v || v.ok === false) return { ok: false, refused: true, gate: 'approve', error: 'approval ' + approvedRef + ' not accepted: ' + ((v && v.reason) || 'unknown') };
    }
  }
  const c = load();
  const L = loops(); const agents = L.agents || {};
  const plan = { loops: [], routines: [], timer: null, errors: [] };
  for (const [id, s] of Object.entries(c.seats)) {
    const row = agents[id];
    if (!row) { plan.errors.push('cadence.json seat "' + id + '" is not in loops.json; skipped'); continue; }
    for (const f of SEAT_FIELDS) if (s[f] !== undefined && row[f] !== s[f]) plan.loops.push({ seat: id, field: f, from: row[f], to: s[f] });
  }
  const wantSched = Object.entries(c.seats).filter(([id, s]) => s.loopEvery != null && agents[id]);
  if (wantSched.length) {
    let jobs = null;
    try { const r = await S.call('GET', '/api/cron'); jobs = (JSON.parse(r.body) || {}).jobs; } catch (e) { plan.errors.push('GET /api/cron failed: ' + e.message); }
    if (Array.isArray(jobs)) for (const [id, s] of wantSched) {
      const prefix = agents[id].loop;
      const hits = prefix ? jobs.filter(x => x && x.name && (x.name === prefix || x.name.startsWith(prefix))) : [];
      if (hits.length !== 1) { plan.errors.push(id + ': ' + (hits.length ? 'loop "' + prefix + '" matches ' + hits.length + ' routines' : 'no routine matches loop "' + prefix + '"')); continue; }
      let want; try { want = parseEvery(s.loopEvery); } catch (e) { plan.errors.push(id + ': ' + e.message); continue; }
      if (!sameSchedule(want, hits[0].schedule)) plan.routines.push({ seat: id, id: hits[0].id, name: hits[0].name, from: (hits[0].schedule && hits[0].schedule.display) || null, to: want.text });
    }
  }
  plan.timer = timerPlan(c.dispatcherTickMin);
  const reload = 'systemctl --user daemon-reload && systemctl --user restart ' + S.service() + '-dispatch.timer';
  if (dry) return { ok: true, dry: true, gate: level, plan: Object.assign({}, plan, { timer: { file: plan.timer.file, missing: !!plan.timer.missing, changed: !!plan.timer.changed } }) };
  const done = [];
  if (plan.loops.length) {
    const fresh = loops();   // re-read right before writing: another tool may have changed it
    for (const ch of plan.loops) if (fresh.agents && fresh.agents[ch.seat]) fresh.agents[ch.seat][ch.field] = ch.to;
    const tmp = S.loopsFile + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(fresh, null, 2) + '\n'); fs.renameSync(tmp, S.loopsFile);
    done.push('loops.json: ' + plan.loops.map(x => x.seat + '.' + x.field + '=' + x.to).join(', '));
  }
  for (const r of plan.routines) {
    try {
      const res = await S.call('POST', '/api/cron/update', { id: r.id, patch: { schedule: r.to } });
      const b = (() => { try { return JSON.parse(res.body); } catch (_) { return {}; } })();
      if (res.status === 200 && b.ok) done.push('routine "' + r.name + '": ' + (r.from || '?') + ' -> ' + r.to);
      else plan.errors.push('routine "' + r.name + '" update refused: HTTP ' + res.status + ' ' + String(res.body).slice(0, 160));
    } catch (e) { plan.errors.push('routine "' + r.name + '" update failed: ' + e.message); }
  }
  let printReload = null;
  if (plan.timer.missing) plan.errors.push('no timer at ' + plan.timer.file + ' (scripts/setup-station.sh installs it, templated from cadence.json)');
  else if (plan.timer.changed) { fs.writeFileSync(plan.timer.file, plan.timer.text); done.push('timer: OnUnitActiveSec=' + c.dispatcherTickMin + 'min'); printReload = reload; }
  if (done.length) {
    const cc = load(); cc.appliedAt = new Date(S.now()).toISOString(); if (by) cc.appliedBy = by; save(cc);
    if (level === 'notify') { try { S.notify('Cadence changed' + (by ? ' by ' + by : '') + ': ' + done.join('; ') + '.'); } catch (e) { plan.errors.push('owner notice failed: ' + e.message); } }
  }
  return { ok: !plan.errors.length, gate: level, applied: done, errors: plan.errors, run: printReload };
}

module.exports = { S, load, view, parseEvery, sameSchedule, setDefault, setSeat, apply };

async function selftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-selftest-'));
  const saved = Object.assign({}, S);
  const cases = [];
  const check = (name, cond, detail) => cases.push({ name, pass: !!cond, detail: detail || '' });
  const calls = []; const told = [];
  const jobs = [{ id: 'j1', name: 'Founder loop', schedule: { kind: 'interval', minutes: 120, display: 'every 2h' } },
    { id: 'j2', name: 'Desk loop', schedule: { kind: 'cron', expr: '0 9 * * *', display: 'cron 0 9 * * *' } }];
  let level = 'auto';
  Object.assign(S, {
    file: path.join(dir, 'work', 'cadence.json'), defaultFile: path.join(dir, 'defaults.json'), loopsFile: path.join(dir, 'loops.json'),
    unitDir: dir, service: () => 'test-station', gate: () => level, governance: () => null, notify: t => told.push(t), now: () => Date.parse('2026-01-05T10:00:00Z'),
    call: async (method, p, body) => {
      calls.push([method, p, body]);
      if (method === 'GET' && p === '/api/cron') return { status: 200, body: JSON.stringify({ jobs }) };
      if (method === 'POST' && p === '/api/cron/update') { const x = jobs.find(y => y.id === body.id); x.schedule = parseEvery(body.patch.schedule); return { status: 200, body: JSON.stringify({ ok: true }) }; }
      return { status: 404, body: '{}' };
    },
  });
  fs.writeFileSync(S.defaultFile, JSON.stringify(BUILTIN));
  fs.writeFileSync(S.loopsFile, JSON.stringify({ _doc: 'x', agents: { agent: { name: 'Alex', loop: 'Founder loop', priority: 100, wakeOnInbox: true, manager: null }, desk: { name: 'Sam', loop: 'Desk loop', cooldownMin: 30, manager: 'agent' } } }));
  fs.writeFileSync(path.join(dir, 'test-station-dispatch.timer'), '[Unit]\nDescription=Run the X dispatcher every 10 minutes\n\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec=10min\n');
  try {
    check('parseEvery minutes', parseEvery('30').text === 'every 30m' && parseEvery('every 2h').minutes === 120);
    check('parseEvery cron', parseEvery('0 9 * * 1-5').kind === 'cron');
    let bad = false; try { parseEvery('weekdays at 9'); } catch (_) { bad = true; }
    check('parseEvery refuses a phrase it cannot compare', bad);
    let v = view();
    check('view merges loops.json and defaults', v.seats.desk.cooldownMin.value === 30 && v.seats.desk.cooldownMin.from === 'loops' && v.seats.agent.cooldownMin.from === 'default' && v.dispatcherTickMin === 10);
    setDefault(15, { by: 'Alex', maxPerTick: 3 });
    setSeat('desk', { by: 'Alex', loopEvery: '45', cooldown: 20, wakeOnOwner: 'off' });
    setSeat('agent', { by: 'Alex', loopEvery: 'every 2h', priority: 90 });
    v = view();
    check('set writes cadence.json and wins in the view', v.seats.desk.cooldownMin.from === 'cadence' && v.seats.desk.cooldownMin.value === 20 && v.maxPerTick === 3 && fs.existsSync(S.file));
    let threw = false; try { setSeat('nobody', { by: 'Alex', cooldown: 5 }); } catch (_) { threw = true; }
    check('set refuses an unknown seat', threw);
    const dry = await apply({ dry: true });
    check('dry-run plans without writing', dry.plan.loops.length === 3 && dry.plan.routines.length === 1 && dry.plan.timer.changed && JSON.parse(fs.readFileSync(S.loopsFile, 'utf8')).agents.desk.cooldownMin === 30, JSON.stringify(dry.plan));
    level = 'approve';
    const refused = await apply({});
    check('approve level refuses without --approved-ref and says how to ask', refused.refused && /inbox\.js ask/.test(refused.error));
    level = 'notify';
    const r = await apply({ by: 'Alex' });
    const L = JSON.parse(fs.readFileSync(S.loopsFile, 'utf8'));
    check('apply writes per-seat fields into loops.json', L.agents.desk.cooldownMin === 20 && L.agents.desk.wakeOnOwnerMessage === false && L.agents.agent.priority === 90 && L._doc === 'x', JSON.stringify(r));
    const ups = calls.filter(c => c[1] === '/api/cron/update');
    check('apply updates only the routine whose schedule changed', ups.length === 1 && ups[0][2].id === 'j2' && ups[0][2].patch.schedule === 'every 45m');
    const t = fs.readFileSync(path.join(dir, 'test-station-dispatch.timer'), 'utf8');
    check('apply rewrites the timer interval', /OnUnitActiveSec=15min/.test(t) && /every 15 minutes/.test(t));
    check('apply prints the systemctl line, never runs it', /systemctl --user daemon-reload && systemctl --user restart test-station-dispatch\.timer/.test(r.run || ''));
    check('notify level tells the owner', told.length === 1 && /Cadence changed/.test(told[0]));
    const again = await apply({ by: 'Alex' });
    check('a second apply changes nothing', again.applied.length === 0 && !again.run && calls.filter(c => c[1] === '/api/cron/update').length === 1, JSON.stringify(again));
  } finally {
    Object.assign(S, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const badc = cases.filter(c => !c.pass);
  for (const c of cases) console.log((c.pass ? 'ok   ' : 'FAIL ') + c.name + (c.pass ? '' : '  [' + c.detail + ']'));
  console.log(badc.length ? 'CADENCE SELFTEST FAILED: ' + badc.length + ' of ' + cases.length : 'CADENCE SELFTEST PASSED: ' + cases.length + ' cases');
  return badc.length ? 1 : 0;
}

if (require.main === module) {
  const a = process.argv.slice(2); const cmd = a[0] || 'show';
  const opt = k => { const i = a.indexOf('--' + k); return i >= 0 ? (a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true) : null; };
  const out = o => console.log(JSON.stringify(o, null, 1));
  (async () => {
    if (cmd === 'selftest' || cmd === '--selftest') process.exit(await selftest());
    if (cmd === 'show') {
      const v = view();
      if (opt('json')) return out(v);
      console.log('dispatcher tick ' + v.dispatcherTickMin + ' min · default cooldown ' + v.defaultCooldownMin + ' min · max ' + v.maxPerTick + ' wakes/tick  (' + v.file + ')');
      for (const [id, s] of Object.entries(v.seats)) {
        const f = k => s[k] ? s[k].value + (s[k].from === 'cadence' ? '' : ' [' + s[k].from + ']') : '-';
        console.log('  ' + id + ' (' + s.name + '): loop "' + (s.loop || '-') + '"' + (s.loopEvery ? ' every=' + s.loopEvery : '') + ' cooldown=' + f('cooldownMin') + ' priority=' + f('priority') + ' wakeOnInbox=' + f('wakeOnInbox') + ' wakeOnOwner=' + f('wakeOnOwnerMessage'));
      }
      if (v.unknownSeats.length) console.log('  not in loops.json: ' + v.unknownSeats.join(', '));
      return;
    }
    const by = typeof opt('by') === 'string' ? opt('by') : null;
    if (cmd === 'set-default') return out(setDefault(a[1] && !a[1].startsWith('--') ? a[1] : null, { by, cooldown: opt('cooldown'), maxPerTick: opt('max-per-tick') }));
    if (cmd === 'set') return out(setSeat(a[1], { by, loopEvery: opt('loop-every'), cooldown: opt('cooldown'), priority: opt('priority'), wakeOnInbox: opt('wake-on-inbox'), wakeOnOwner: opt('wake-on-owner') }));
    if (cmd === 'apply') {
      const r = await apply({ dry: !!opt('dry-run'), approvedRef: typeof opt('approved-ref') === 'string' ? opt('approved-ref') : null, by });
      out(r);
      if (r.run) console.log('\nNow run: ' + r.run);
      process.exit(r.ok ? 0 : 1);
    }
    throw new Error('commands: show, set-default, set, apply, selftest');
  })().catch(e => { console.error(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });
}
