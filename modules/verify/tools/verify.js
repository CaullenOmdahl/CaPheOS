#!/usr/bin/env node
/* verify.js — independent outcome checks on commitments the seat says are done.
 *
 * A seat that did the work saying "done" is a claim. This tool, run from the dispatcher's module tick (modules/verify/
 * tick.js, a non-agent process), checks the claim against the commitment's `verify` spec and moves it on:
 *   pass    -> verified        (by "verify")
 *   fail    -> in_progress     (by "verify", the failure in the note)
 *   pending -> stays done      (a judge with no station, or a check that needs a human: recorded pending-human)
 * through commitments.js when that module is enabled; every result is also appended to company/work/verify/results.jsonl
 * (the record evidence.js exports). The seat that did the work (owner, or whoever moved it to in_progress/done) can
 * never mark it verified: `mark` refuses them, and mayVerify(c, by) is exported for commitments.js to enforce the same.
 *
 * Spec (commitment.verify): one check, an array of checks, or { checks: [...] }:
 *   { type: 'http', url, status?: 200, contains?: '<text>' }              GET through the external gate (category network)
 *   { type: 'json', url | file, path: 'a.b.0', equals? | exists? | min? | max? }
 *   { type: 'file', path: '<company-relative>', sha256: '<hex>' }
 *   { type: 'judge', rubric: '<fixed rubric>', family?: '<model family other than the doer's>' }
 *        a second model family's judgement: queued to company/work/verify/judge-queue.jsonl; with no reachable station
 *        it is recorded pending-human / needs-station. A judge result never comes from the seat that did the work.
 *
 *   node verify.js run [--id <commitment>] [--dry]     check every done commitment with a spec (or one)
 *   node verify.js mark --id <c> --outcome pass|fail --by <seat> [--note ..]   a human/second-seat verdict (never the doer)
 *   node verify.js failures [--json]                   recent failures; writes company/work/verify/failures.json (panel)
 *   node verify.js --selftest
 * Owner of this tool: the risk function. Port 8800 is never contacted.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const S = require((() => { let d = __dirname; for (let i = 0; i < 6; i++, d = path.dirname(d)) { const f = path.join(d, 'company', 'tools', 'lib', 'settle.js'); if (fs.existsSync(f)) return f; } return path.join(__dirname, 'lib', 'settle.js'); })());
const co = S.co;

const RESULTS = () => S.work('verify', 'results.jsonl');
const QUEUE = () => S.work('verify', 'judge-queue.jsonl');
const FAILS = () => S.work('verify', 'failures.json');
const VERIFIER = 'verify';
let GATE_OPTS = null;   // selftest only: a scratch allowlist for the network check

function specOf(c) { const v = c && c.verify; if (!v) return []; if (Array.isArray(v)) return v; if (Array.isArray(v.checks)) return v.checks; return [v]; }
function lastDone(c) { const h = (c.history || []).filter(x => x.to === 'done'); return h.length ? h[h.length - 1] : null; }
function mayVerify(c, by) {
  const b = String(by || '').trim().toLowerCase();
  if (!b) return { ok: false, why: 'no verifier named' };
  if (S.doers(c).has(b)) return { ok: false, why: b + ' did the work on ' + c.id + ' and can never mark it verified' };
  return { ok: true };
}
function insideRoot(rel) {
  const a = path.resolve(co.ROOT, String(rel || ''));
  if (path.isAbsolute(String(rel || '')) || !a.startsWith(path.resolve(co.ROOT) + path.sep) || /(^|\/)secrets(\/|$)/.test(rel)) return null;
  return a;
}
function badUrl(u) {
  let x; try { x = new URL(String(u)); } catch (_) { return 'not a URL'; }
  if (!/^https?:$/.test(x.protocol)) return 'only http(s)';
  if (x.port === '8800') return 'port 8800 is never contacted';
  return null;
}
async function get(url, agent) {
  const why = badUrl(url); if (why) return { ok: false, detail: why };
  const g = S.gate().check({ category: 'network', target: url, agent: agent || VERIFIER, note: 'verify check' }, GATE_OPTS || {});
  if (!g.allow) return { ok: false, blocked: true, detail: 'external gate refused: ' + g.reason };
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'manual' });
    return { ok: true, status: r.status, body: (await r.text()).slice(0, 1e6) };
  } catch (e) { return { ok: false, detail: 'fetch failed: ' + e.message }; }
}
async function runCheck(ck, c) {
  const t = ck && ck.type;
  if (t === 'http') {
    const r = await get(ck.url); if (!r.ok) return { type: t, ok: false, detail: r.detail };
    const want = ck.status || 200;
    if (r.status !== want) return { type: t, ok: false, detail: 'status ' + r.status + ', expected ' + want };
    if (ck.contains && !r.body.includes(ck.contains)) return { type: t, ok: false, detail: 'body does not contain "' + String(ck.contains).slice(0, 60) + '"' };
    return { type: t, ok: true, detail: 'status ' + r.status };
  }
  if (t === 'json') {
    let txt;
    if (ck.file) { const a = insideRoot(ck.file); if (!a) return { type: t, ok: false, detail: 'file must be company-relative, inside the root, not under secrets/' }; try { txt = fs.readFileSync(a, 'utf8'); } catch (e) { return { type: t, ok: false, detail: 'unreadable: ' + ck.file }; } }
    else { const r = await get(ck.url); if (!r.ok) return { type: t, ok: false, detail: r.detail }; txt = r.body; }
    let j; try { j = JSON.parse(txt); } catch (_) { return { type: t, ok: false, detail: 'not JSON' }; }
    const v = S.dget(j, ck.path);
    if ('equals' in ck && JSON.stringify(v) !== JSON.stringify(ck.equals)) return { type: t, ok: false, detail: ck.path + ' = ' + JSON.stringify(v) + ', expected ' + JSON.stringify(ck.equals) };
    if (ck.exists !== false && v === undefined) return { type: t, ok: false, detail: ck.path + ' is missing' };
    if ('min' in ck && !(Number(v) >= ck.min)) return { type: t, ok: false, detail: ck.path + ' = ' + v + ' < ' + ck.min };
    if ('max' in ck && !(Number(v) <= ck.max)) return { type: t, ok: false, detail: ck.path + ' = ' + v + ' > ' + ck.max };
    return { type: t, ok: true, detail: ck.path + ' = ' + JSON.stringify(v).slice(0, 80) };
  }
  if (t === 'file') {
    const a = insideRoot(ck.path); if (!a) return { type: t, ok: false, detail: 'path must be company-relative, inside the root, not under secrets/' };
    let buf; try { buf = fs.readFileSync(a); } catch (_) { return { type: t, ok: false, detail: 'missing: ' + ck.path }; }
    const got = S.sha256(buf); const want = String(ck.sha256 || '').replace(/^sha256:/, '').toLowerCase();
    return got === want ? { type: t, ok: true, detail: 'sha256 matches' } : { type: t, ok: false, detail: 'sha256 ' + got.slice(0, 12) + '…, expected ' + (want.slice(0, 12) || '(none given)') + '…' };
  }
  if (t === 'judge') {
    if (!ck.rubric) return { type: t, ok: false, detail: 'a judge check needs a fixed rubric' };
    const st = S.stationReachable();
    S.appendJsonl(QUEUE(), { at: new Date().toISOString(), commitment: c.id, party: c.party || null, rubric: ck.rubric, family: ck.family || 'other-than-doer', doers: [...S.doers(c)], status: st.ok ? 'queued' : 'needs-station' });
    return { type: t, ok: null, pending: 'pending-human', needs: st.ok ? 'judge-run' : 'needs-station', detail: st.ok ? 'queued for a second-family judge' : 'no station reachable (' + st.why + '): a human or a station judge decides' };
  }
  return { type: String(t), ok: false, detail: 'unknown check type (fail closed)' };
}
function already(c, done) { return S.readJsonl(RESULTS()).some(r => r.commitment === c.id && r.doneAt === (done && done.at) && r.outcome !== 'pending'); }

async function verifyOne(c, o) {
  o = o || {};
  const done = lastDone(c);
  const checks = []; for (const ck of specOf(c)) checks.push(await runCheck(ck, c));
  const outcome = checks.some(x => x.ok === false) ? 'fail' : checks.some(x => x.ok === null) ? 'pending' : 'pass';
  const row = { id: S.newId('vr'), at: new Date().toISOString(), commitment: c.id, party: c.party || null, doneAt: done ? done.at : null, doneBy: done ? done.by : null, outcome, by: VERIFIER, checks };
  if (o.dry) return Object.assign(row, { dry: true });
  if (outcome === 'pass') row.transition = S.transition(c.id, 'verified', { by: VERIFIER, note: 'verify: ' + checks.length + ' check(s) passed' });
  if (outcome === 'fail') row.transition = S.transition(c.id, 'in_progress', { by: VERIFIER, note: 'verify failed: ' + checks.filter(x => x.ok === false).map(x => x.type + ': ' + x.detail).join('; ').slice(0, 400) });
  if (outcome === 'pending') row.pending = checks.filter(x => x.ok === null).map(x => x.needs);
  S.appendJsonl(RESULTS(), row);
  return row;
}
async function run(o) {
  o = o || {};
  const list = S.commitments().filter(c => (o.id ? c.id === o.id : true) && c.state === 'done' && specOf(c).length);
  const out = [];
  for (const c of list) {
    if (already(c, lastDone(c))) continue;
    // a pending judge is asked once per done-transition, then waits for `mark`
    if (!o.id && S.readJsonl(RESULTS()).some(r => r.commitment === c.id && r.doneAt === (lastDone(c) || {}).at && r.outcome === 'pending')) continue;
    out.push(await verifyOne(c, o));
  }
  if (!o.dry) failures();
  return out;
}
function mark(o) {
  const c = S.commitment(o.id); if (!c) throw new Error('no commitment ' + o.id);
  if (!['pass', 'fail'].includes(o.outcome)) throw new Error('--outcome pass|fail');
  if (c.state !== 'done') throw new Error(c.id + ' is ' + c.state + ', not done');
  const m = mayVerify(c, o.by); if (!m.ok) throw new Error(m.why);
  if (String(o.by).toLowerCase() === VERIFIER) throw new Error('"verify" is the tick\'s own name; a human verdict names the person');
  const done = lastDone(c);
  const row = { id: S.newId('vr'), at: new Date().toISOString(), commitment: c.id, party: c.party || null, doneAt: done ? done.at : null, doneBy: done ? done.by : null,
    outcome: o.outcome, by: String(o.by), human: true, note: String(o.note || '').slice(0, 400), checks: [] };
  row.transition = S.transition(c.id, o.outcome === 'pass' ? 'verified' : 'in_progress', { by: 'verify:' + String(o.by), note: 'verify (' + o.by + '): ' + (o.note || o.outcome) });
  S.appendJsonl(RESULTS(), row);
  failures();
  return row;
}
function failures() {
  const rows = S.readJsonl(RESULTS()).filter(r => r.outcome === 'fail' || r.outcome === 'pending').slice(-200).reverse()
    .map(r => ({ at: r.at, commitment: r.commitment, party: r.party, outcome: r.outcome, doneBy: r.doneBy, detail: (r.checks || []).filter(x => x.ok !== true).map(x => x.type + ': ' + x.detail).join('; ') || r.note || '', pending: r.outcome === 'pending' }));
  S.writeJson(FAILS(), rows);
  return rows;
}

function selftest() {
  return S.selftest(__filename, async ok => {
    const http = require('http');
    const srv = http.createServer((q, r) => { if (q.url === '/ok') { r.end('{"status":"live","n":3}'); } else { r.statusCode = 500; r.end('down'); } });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + srv.address().port;
    const allow = path.join(co.ROOT, 'allow.txt'); fs.writeFileSync(allow, '127.0.0.1:' + srv.address().port + '\n');   // the gate's host includes the port
    GATE_OPTS = { allowlist: allow };
    const ID = {}; ['c-pass', 'c-fail', 'c-judge', 'c-blocked', 'c-8800', 'c-open', 'c-later'].forEach((n, i) => { ID[n] = 'c-202601010000-00000' + i; });
    const cdir = S.work('commitments'); fs.mkdirSync(cdir, { recursive: true });
    fs.mkdirSync(S.work('out'), { recursive: true }); fs.writeFileSync(S.work('out', 'a.txt'), 'deliverable');
    const mk = (id, verify, extra) => { const c = Object.assign({ id, key: id, party: 'acme', title: id, state: 'done', owner: 'sam', createdAt: '2026-01-01T00:00:00Z',
      history: [{ at: '2026-01-01T00:00:00Z', from: null, to: 'received', by: 'intake' }, { at: '2026-01-02T00:00:00Z', from: 'in_progress', to: 'done', by: 'sam' }], evidence: [], verify }, extra || {});
      fs.writeFileSync(path.join(cdir, id + '.json'), JSON.stringify(c)); return c; };
    mk(ID['c-pass'], [{ type: 'http', url: base + '/ok', contains: 'live' }, { type: 'json', url: base + '/ok', path: 'n', min: 2 },
      { type: 'file', path: 'company/work/out/a.txt', sha256: S.sha256('deliverable') }]);
    mk(ID['c-fail'], { type: 'http', url: base + '/bad' });
    mk(ID['c-judge'], { type: 'judge', rubric: 'Does the report answer the three questions?' });
    mk(ID['c-blocked'], { type: 'http', url: 'http://example.invalid/x' });
    mk(ID['c-8800'], { type: 'http', url: 'http://127.0.0.1:8800/api' });
    mk(ID['c-open'], { type: 'file', path: 'x' }, { state: 'in_progress' });
    S.override('commitments', null);   // first without the commitments module: results are recorded only
    const dry = await run({ dry: true });
    ok('dry run checks but records nothing', dry.length === 5 && !fs.existsSync(RESULTS()));
    const res = await run({});
    const by = id => res.find(r => r.commitment === id) || {};
    ok('http + json + file checks pass', by(ID['c-pass']).outcome === 'pass', by(ID['c-pass']));
    ok('a 500 fails with the reason', by(ID['c-fail']).outcome === 'fail' && /status 500/.test(JSON.stringify(by(ID['c-fail']).checks)));
    ok('judge with no station is pending-human / needs-station', by(ID['c-judge']).outcome === 'pending' && by(ID['c-judge']).checks[0].needs === 'needs-station' && by(ID['c-judge']).checks[0].pending === 'pending-human');
    ok('judge is queued with the doers named', S.readJsonl(QUEUE()).some(q => q.commitment === ID['c-judge'] && q.doers.includes('sam') && q.status === 'needs-station'));
    ok('a host off the allowlist is refused by the external gate', by(ID['c-blocked']).outcome === 'fail' && /external gate refused/.test(JSON.stringify(by(ID['c-blocked']).checks)));
    ok('port 8800 is never contacted', by(ID['c-8800']).outcome === 'fail' && /8800/.test(JSON.stringify(by(ID['c-8800']).checks)));
    ok('a commitment not in done is not checked', !by(ID['c-open']).commitment);
    ok('without commitments.js the transition is recorded only', by(ID['c-pass']).transition && by(ID['c-pass']).transition.ok === false);
    ok('results.jsonl holds every result', S.readJsonl(RESULTS()).length === 5);
    ok('a second run does not re-check', (await run({})).length === 0);
    ok('failures.json lists fail and pending for the panel', S.readJson(FAILS(), []).some(f => f.commitment === ID['c-fail']) && S.readJson(FAILS(), []).some(f => f.pending));
    let refused = ''; try { mark({ id: ID['c-judge'], outcome: 'pass', by: 'Sam' }); } catch (e) { refused = e.message; }
    ok('the seat that did the work can never mark verified', /can never mark it verified/.test(refused));
    ok('mayVerify refuses the owner, allows another seat', !mayVerify({ id: 'x', owner: 'sam', history: [] }, 'sam').ok && mayVerify({ id: 'x', owner: 'sam', history: [] }, 'kim').ok);
    const m = mark({ id: ID['c-judge'], outcome: 'pass', by: 'kim', note: 'read it against the rubric' });
    ok('another seat may mark a pending judge', m.outcome === 'pass' && m.human);
    // with a commitments tool exporting transition(), the commitment moves
    const moved = [];
    S.override('commitments', undefined);   // now through the real commitments module (source copy in a selftest)
    mk(ID['c-later'], { type: 'file', path: 'company/work/out/a.txt', sha256: 'deadbeef' });
    const r2 = await run({ id: ID['c-later'] });
    const c2 = S.readJson(path.join(cdir, ID['c-later'] + '.json'), {});
    ok('a failure moves the commitment back to in_progress with the failure', r2[0] && r2[0].transition.ok && c2.state === 'in_progress' && /sha256/.test(c2.history.slice(-1)[0].note) && c2.history.slice(-1)[0].by === 'verify', [c2.state, c2.history]);
    srv.close(); void moved;
  });
}

if (require.main === module) {
  const a = S.args();
  const cmd = a._[0] || (a.selftest ? 'selftest' : '');
  (async () => {
    try {
      if (cmd === 'selftest') return selftest();
      if (cmd === 'run') S.out(0, await run({ id: a.id, dry: !!a.dry }));
      else if (cmd === 'mark') S.out(0, mark({ id: a.id, outcome: a.outcome, by: a.by, note: a.note }));
      else if (cmd === 'failures') { const f = failures(); if (a.json) S.out(0, f); for (const r of f) console.log(r.at + '  ' + r.commitment + '  ' + r.outcome + '  ' + r.detail); }
      else S.out(2, { ok: false, error: 'commands: run, mark, failures, --selftest' });
    } catch (e) { S.out(1, { ok: false, error: e.message }); }
  })();
}
module.exports = { run, verifyOne, mark, mayVerify, failures, specOf };
