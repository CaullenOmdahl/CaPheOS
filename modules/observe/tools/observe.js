#!/usr/bin/env node
/* observe.js — watched targets with history: declarative probes on a cadence, results appended per target, threshold
 * and change events emitted into intake.
 *
 * Targets: company/work/observe/targets.json  { "targets": [ { id, kind, every (minutes), party?, onChange?, expect? , ... } ] }
 *   kind http     { url }                    value = status; ms = latency.  expect: { status: 200, maxMs: 2000 }
 *   kind json     { url, path }              value = the dot path's value.  expect: { equals | min | max }
 *   kind file     { file }                   value = sha256 of a file under the company root (never outside it)
 *   kind command  { argv: [..] }             value = exit code (no shell). OFF while the localComputer guardrail is on.
 * History: company/work/observe/<id>.jsonl  {at, ok, value, ms?, error?}. Events (intake, source "observe"):
 *   observe.threshold (ok -> failing), observe.recovered (failing -> ok), observe.change (value changed, onChange true).
 * Every URL fetch is an external-gate `network` check; a loopback target still needs its host on the allowlist.
 * Limits (kit.limits: company/state/modules/<id>/limits/ once the owner opens them; shipped closed): maxTargets.
 *
 *   node company/tools/observe.js run [--target <id>] [--dry] [--json]
 *   node company/tools/observe.js list [--json]
 *   node company/tools/observe.js history <id> [--limit N] [--json]
 *   node company/tools/observe.js --selftest
 * Module: require('./observe.js') -> { run, probe, targets, history }.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const LIB = [path.join(__dirname, 'lib'), path.join(__dirname, '..', '..', '..', 'company', 'tools', 'lib')].find(d => fs.existsSync(path.join(d, 'modkit.js')));
const co = require(path.join(LIB, 'company'));
const kit = require(path.join(LIB, 'modkit'));

const ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
const DIR = () => co.p('company', 'work', 'observe');
const TARGETS = () => path.join(DIR(), 'targets.json');
const STATE = () => path.join(DIR(), 'state.json');
const HIST = id => path.join(DIR(), id + '.jsonl');

function targets() { const t = co.readJson(TARGETS(), {}) || {}; return (Array.isArray(t.targets) ? t.targets : []).filter(x => x && ID_RE.test(String(x.id))); }
function history(id, n) { const l = kit.readJsonl(HIST(id)); return n ? l.slice(-n) : l; }

async function get(url, o) {
  if (o.gate) { if (!o.gate(url)) throw new Error('gate refused ' + url); }
  else {
    const gate = kit.tool('external-gate');
    if (!gate) throw new Error('external-gate.js missing: network refused (fail closed)');
    const d = gate.check({ category: 'network', target: url, agent: 'observe', note: 'observe probe' });
    if (!d.allow) throw new Error('external gate refused ' + url + ': ' + d.reason);
  }
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), o.timeoutMs || 10000);
  const t0 = Date.now();
  try { const r = await fetch(url, { signal: ctl.signal, redirect: 'manual' }); const text = await r.text(); return { status: r.status, ms: Date.now() - t0, text: text.slice(0, 2 * 1024 * 1024) }; }
  finally { clearTimeout(t); }
}

async function probe(t, o) {
  o = o || {};
  const e = t.expect || {};
  if (t.kind === 'http') {
    const r = await get(t.url, o);
    const okStatus = e.status ? r.status === e.status : r.status >= 200 && r.status < 400;
    return { ok: okStatus && (!e.maxMs || r.ms <= e.maxMs), value: r.status, ms: r.ms };
  }
  if (t.kind === 'json') {
    const r = await get(t.url, o);
    let v; try { v = kit.dget(JSON.parse(r.text), t.path); } catch (_) { return { ok: false, value: null, ms: r.ms, error: 'not JSON' }; }
    let okv = v !== undefined;
    if ('equals' in e) okv = okv && JSON.stringify(v) === JSON.stringify(e.equals);
    if (typeof e.min === 'number') okv = okv && Number(v) >= e.min;
    if (typeof e.max === 'number') okv = okv && Number(v) <= e.max;
    return { ok: okv, value: v === undefined ? null : v, ms: r.ms };
  }
  if (t.kind === 'file') {
    const f = path.resolve(co.ROOT, String(t.file || ''));
    if (!f.startsWith(path.resolve(co.ROOT) + path.sep) || /(^|\/)secrets(\/|$)/.test(path.relative(co.ROOT, f))) return { ok: false, value: null, error: 'file must be inside the company root and not under secrets/' };
    try { return { ok: true, value: crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16) }; } catch (_) { return { ok: false, value: null, error: 'unreadable' }; }
  }
  if (t.kind === 'command') {
    if (co.guard('localComputer')) return { ok: false, value: null, error: 'command probes are off while the localComputer guardrail is on', skipped: true };
    if (!Array.isArray(t.argv) || !t.argv.length) return { ok: false, value: null, error: 'argv required' };
    const r = spawnSync(t.argv[0], t.argv.slice(1).map(String), { cwd: co.ROOT, timeout: 30000, encoding: 'utf8' });
    const want = typeof e.exit === 'number' ? e.exit : 0;
    return { ok: r.status === want, value: r.status };
  }
  return { ok: false, value: null, error: 'unknown kind ' + t.kind };
}

function emit(type, t, data, at, o) {
  const intake = o.intake !== undefined ? o.intake : kit.tool('intake');
  if (!intake) return 'intake not enabled';
  const ev = intake.normalise('observe', { data: Object.assign({ target: t.id }, data) }, { key: t.id + ':' + type + ':' + at, type, party: t.party, via: 'observe', now: Date.parse(at) });
  return o.dry ? 'dry' : (intake.ingest(ev).ok ? 'emitted' : 'refused');
}

async function run(o) {
  o = o || {};
  const now = o.now || Date.now(); const log = o.log || (() => {});
  const st = co.readJson(STATE(), {}) || {};
  const max = kit.limit('observe', 'maxTargets');
  const all = targets().filter(t => !o.target || t.id === o.target);
  const out = [];
  all.forEach((t, i) => { if (i >= max) out.push({ id: t.id, skipped: 'over the maxTargets limit (' + max + ')' }); });
  for (const t of all.slice(0, max)) {
    const s = st[t.id] || {};
    const every = Math.max(1, Number(t.every) || 15) * 60000;
    if (!o.target && s.lastAt && now - Date.parse(s.lastAt) < every) { out.push({ id: t.id, skipped: 'not due' }); continue; }
    let r; try { r = await probe(t, o); } catch (e) { r = { ok: false, value: null, error: e.message }; }
    const at = new Date(now).toISOString();
    const row = Object.assign({ at }, r);
    if (!o.dry) kit.appendJsonl(HIST(t.id), row);
    const events = [];
    if (!r.skipped) {
      if (s.lastOk !== undefined && s.lastOk && !r.ok) events.push(['observe.threshold', { value: r.value, error: r.error || null, ms: r.ms }]);
      if (s.lastOk === undefined && !r.ok) events.push(['observe.threshold', { value: r.value, error: r.error || null, ms: r.ms, first: true }]);
      if (s.lastOk === false && r.ok) events.push(['observe.recovered', { value: r.value }]);
      if (t.onChange && 'lastValue' in s && JSON.stringify(s.lastValue) !== JSON.stringify(r.value) && r.value !== null) events.push(['observe.change', { from: s.lastValue, to: r.value }]);
    }
    const emitted = events.map(([type, d]) => type + ':' + emit(type, t, d, at, o));
    st[t.id] = { lastAt: at, lastOk: r.skipped ? s.lastOk : r.ok, lastValue: r.value === null && 'lastValue' in s ? s.lastValue : r.value };
    out.push({ id: t.id, ok: r.ok, value: r.value, error: r.error, events: emitted });
    if (emitted.length) log('OBSERVE ' + t.id + ': ' + emitted.join(', '));
  }
  if (!o.dry) kit.writeJson(STATE(), st);
  return { ok: true, targets: out };
}

module.exports = { run, probe, targets, history };

async function selftest(ok) {
  const http = require('http');
  let up = true, val = 1;
  const srv = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(up ? 200 : 503); return res.end('x'); }
    if (req.url === '/j') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ a: { b: val } })); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  fs.mkdirSync(DIR(), { recursive: true });
  fs.writeFileSync(path.join(co.ROOT, 'watched.txt'), 'one');
  kit.writeJson(TARGETS(), { targets: [
    { id: 'site', kind: 'http', url: base + '/health', every: 5, expect: { status: 200 } },
    { id: 'depth', kind: 'json', url: base + '/j', path: 'a.b', every: 5, onChange: true, expect: { max: 5 } },
    { id: 'conf', kind: 'file', file: 'watched.txt', every: 5, onChange: true },
    { id: 'cmd', kind: 'command', argv: ['true'], every: 5 },
    { id: 'esc', kind: 'file', file: '../../etc/passwd', every: 5 } ] });
  const gate = () => true;
  let r = await run({ gate });
  ok('closed limit runs no target', r.targets.every(t => /maxTargets/.test(t.skipped || '')), r);
  kit.setLimits(co.ROOT, 'observe', { maxTargets: 10 });
  const T = (x, id) => x.targets.find(t => t.id === id) || {};
  const t0 = Date.now();
  r = await run({ gate, now: t0 });
  ok('http probe ok with status', T(r, 'site').ok === true && T(r, 'site').value === 200, r);
  ok('json path value read', T(r, 'depth').value === 1);
  ok('file digest taken', typeof T(r, 'conf').value === 'string' && T(r, 'conf').value.length === 16);
  ok('command probe off while localComputer is on', /localComputer/.test(T(r, 'cmd').error || ''));
  ok('file outside the root refused', /inside the company root/.test(T(r, 'esc').error || ''));
  ok('history appended per target', history('site').length === 1);
  up = false; val = 9; fs.writeFileSync(path.join(co.ROOT, 'watched.txt'), 'two');
  r = await run({ gate, now: t0 + 60000 });
  ok('not due before its cadence', T(r, 'site').skipped === 'not due');
  r = await run({ gate, now: t0 + 6 * 60000 });
  const evs = () => kit.readJsonl(co.p('company', 'work', 'intake', 'events.jsonl'));
  ok('threshold event into intake when it starts failing', evs().some(e => e.source === 'observe' && e.type === 'observe.threshold' && e.data.target === 'site'), evs());
  ok('change events for json and file', evs().filter(e => e.type === 'observe.change').map(e => e.data.target).sort().join() === 'conf,depth');
  ok('json threshold (max 5) breached too', evs().some(e => e.type === 'observe.threshold' && e.data.target === 'depth'));
  r = await run({ gate, now: t0 + 12 * 60000 });
  ok('no repeat event while still failing', evs().filter(e => e.type === 'observe.threshold' && e.data.target === 'site').length === 1);
  up = true;
  r = await run({ gate, now: t0 + 18 * 60000 });
  ok('recovered event', evs().some(e => e.type === 'observe.recovered' && e.data.target === 'site'));
  r = await run({ gate: () => false, target: 'site' });
  ok('a gate refusal is a failed probe, not a fetch', /gate refused/.test(T(r, 'site').error || ''));
  srv.close();
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest') || argv[0] === 'selftest') { kit.runSelftest(__filename, 'observe', selftest); return; }
  const a = kit.args(argv);
  const out = (o, text) => console.log(a.json ? JSON.stringify(o, null, 2) : text);
  const [cmd, id] = a._;
  (async () => {
    if (cmd === 'run') { const r = await run({ target: a.target, dry: !!(a.dry || a['dry-run']), log: console.log }); out(r, r.targets.map(t => t.id + '  ' + (t.skipped ? 'skipped: ' + t.skipped : (t.ok ? 'ok ' : 'FAIL ') + JSON.stringify(t.value) + (t.error ? ' ' + t.error : ''))).join('\n') || '(no targets)'); }
    else if (cmd === 'list') { const l = targets(); out(l, l.map(t => t.id + '  ' + t.kind + '  every ' + (t.every || 15) + ' min').join('\n') || '(no targets)'); }
    else if (cmd === 'history') { if (!ID_RE.test(String(id))) throw new Error('target id required'); const l = history(id, Number(a.limit) || 20); out(l, l.map(x => x.at + '  ' + (x.ok ? 'ok ' : 'FAIL ') + JSON.stringify(x.value)).join('\n')); }
    else { console.error('usage: observe.js run|list|history|--selftest (see header)'); process.exit(2); }
  })().catch(e => { console.error(e.message); process.exit(1); });
}
