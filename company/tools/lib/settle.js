'use strict';
/* settle.js — shared plumbing for the Act/Verify/Settle core modules (docs/CORE-MODULES.md): scopes, verify, evidence,
 * reports, ledger. Builds on lib/modkit.js (paths, limits, jsonl, enabled tools) and adds what those five share.
 *
 *   const S = require('./lib/settle')      // from a module folder: walk up to company/tools/lib/ (see any module tool)
 *   S.work('ledger', 'ledger.jsonl')       path under company/work/
 *   S.sha256(buf)  S.readJson(f, fb)  S.args()  S.tester(name)
 *   S.partyPath(id, ...rest)               parties.js path() when enabled, else company/work/parties/<id>/... (contract path)
 *   S.parties()                            known party ids
 *   S.emitEvent(ev)                        Event {id, at, source, type, key, party?, data, receivedVia}; intake.js when
 *                                          enabled, else company/work/intake/events.jsonl; deduped on key
 *   S.commitments() / S.commitment(id)     company/work/commitments/*.json (contract shape)
 *   S.transition(id, to, {by, note})       through commitments.js when enabled; {ok:false} when it is not
 *   S.doers(c)                             the seats that did the work on a commitment (owner + in_progress/done movers)
 *   S.stationReachable()                   GET /api/cron with the token, 3 s; port 8800 is never contacted
 *   S.selftest(file, body)                 modkit.runSelftest with the framework defaults copied into the temp root
 *
 * Cross-module calls are optional and probed at runtime, so each module works before or without its neighbours.
 * Owner: the tools function.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const co = require('./company');
const kit = require('./modkit');

const CODE_ROOT = path.resolve(__dirname, '..', '..', '..');
const work = (...p) => co.p('company', 'work', ...p);
const sha256 = data => crypto.createHash('sha256').update(Buffer.isBuffer(data) ? data : Buffer.from(String(data))).digest('hex');
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } };
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// enabled sibling tools (company/tools/<name>.js); selftests may stand one in with S.override(name, mod)
const OVERRIDE = {};
const tool = name => (Object.prototype.hasOwnProperty.call(OVERRIDE, name) ? OVERRIDE[name] : kit.tool(name));
const override = (name, mod) => { if (mod === undefined) delete OVERRIDE[name]; else OVERRIDE[name] = mod; };

function partyPath(id, ...rest) {
  if (!ID_RE.test(String(id || ''))) throw new Error('bad party id "' + id + '" (lowercase letters, digits, - and _)');
  const P = tool('parties');
  if (P && typeof P.path === 'function') return P.path(id, ...rest);   // its refusal (unknown party, escaping part) stands
  return work('parties', id, ...rest);
}
function parties() {
  const P = tool('parties');
  if (P && typeof P.list === 'function') { try { return P.list().map(x => (typeof x === 'string' ? x : x && x.id)).filter(Boolean); } catch (_) {} }
  try { return fs.readdirSync(work('parties')).filter(d => ID_RE.test(d)); } catch (_) { return []; }
}

const EVENTS = () => work('intake', 'events.jsonl');
function emitEvent(ev) {
  const e = Object.assign({ id: kit.newId('ev'), at: new Date().toISOString(), data: {}, receivedVia: 'module' }, ev);
  if (!e.source || !e.type || !e.key) throw new Error('an event needs source, type and key');
  const I = tool('intake');
  for (const fn of ['emit', 'append', 'record', 'ingest']) if (I && typeof I[fn] === 'function') { try { return I[fn](e) || e; } catch (_) { break; } }
  if (kit.readJsonl(EVENTS()).some(r => r.key === e.key)) return Object.assign({ duplicate: true }, e);
  return appendJsonl(EVENTS(), e);
}

const CDIR = () => work('commitments');
// opts.archived: also the finished ones retention.js moved to commitments/archive/YYYY-MM/ (reports, evidence windows)
function commitments(opts) {
  const o = opts || {};
  const C = tool('commitments');
  if (C && typeof C.list === 'function') { try { const l = C.list(o.archived ? { archived: true } : undefined); if (Array.isArray(l)) return l; } catch (_) {} }
  let names = []; try { names = fs.readdirSync(CDIR()).filter(f => f.endsWith('.json')).map(f => path.join(CDIR(), f)); } catch (_) {}
  if (o.archived) { try { for (const m of fs.readdirSync(path.join(CDIR(), 'archive'))) { try { for (const f of fs.readdirSync(path.join(CDIR(), 'archive', m))) if (f.endsWith('.json')) names.push(path.join(CDIR(), 'archive', m, f)); } catch (_) {} } } catch (_) {} }
  return names.map(f => readJson(f, null)).filter(c => c && c.id && c.state);
}
function commitment(id) {
  const C = tool('commitments');
  if (C && typeof C.get === 'function') { try { const c = C.get(id); if (c) return c; } catch (_) {} }
  return commitments({ archived: true }).find(c => c.id === id) || null;
}
function transition(id, to, o) {
  o = o || {};
  const C = tool('commitments');
  for (const fn of ['transition', 'move', 'setState']) {
    if (C && typeof C[fn] === 'function') {
      try { const r = C[fn].length >= 3 ? C[fn](id, to, o.by, o.note, o.evidence) : C[fn](id, to, { by: o.by, note: o.note }); return { ok: !(r && r.ok === false), via: 'commitments.' + fn, result: r }; }
      catch (e) { return { ok: false, via: 'commitments.' + fn, error: e.message }; }
    }
  }
  return { ok: false, via: null, error: 'commitments tool not enabled; result recorded only' };
}
function doers(c) {
  const s = new Set(); if (c && c.owner) s.add(String(c.owner).toLowerCase());
  for (const h of (c && c.history) || []) if (['in_progress', 'done'].includes(h.to) && h.by) s.add(String(h.by).toLowerCase());
  return s;
}

function stationReachable() {
  const url = co.STATION_URL.replace(/\/+$/, '');
  if (/:8800(\/|$)/.test(url)) return { ok: false, why: 'station URL points at port 8800, which is never contacted' };
  const tok = co.secret('station-token'); if (!tok) return { ok: false, why: 'no station token' };
  try {
    const out = require('child_process').execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '3', '-H', 'x-starnet-token: ' + tok, url + '/api/cron'], { encoding: 'utf8', timeout: 5000 });
    return out.trim() === '200' ? { ok: true } : { ok: false, why: 'station answered ' + out.trim() };
  } catch (_) { return { ok: false, why: 'station unreachable' }; }
}

/* Selftest in a temp root; the framework defaults (governance, guardrails) are copied in so gates read real policy. */
function selftest(file, body) {
  if (process.env.MODKIT_SELFTEST_INNER !== '1') {
    const root = kit.selftestRoot(path.basename(file, '.js'));
    fs.cpSync(path.join(CODE_ROOT, 'company', 'defaults'), path.join(root, 'company', 'defaults'), { recursive: true });
    const r = require('child_process').spawnSync(process.execPath, [file, '--selftest'], { stdio: 'inherit',
      env: Object.assign({}, process.env, { CAPHEOS_ROOT: root, MODKIT_SELFTEST_INNER: '1', CAPHEOS_MODKIT_SOURCE: '1', STARNET_URL: 'http://127.0.0.1:1', PROVENANCE_ROOT: root }) });
    fs.rmSync(root, { recursive: true, force: true });
    process.exit(r.status == null ? 1 : r.status);
  }
  return kit.runSelftest(file, path.basename(file, '.js'), body);
}
/* Writes that tell provenance.js who wrote them, so a meter registered with writers (class A, e.g. the ledger) is
 * recognised by locked-watch.js as the tool's own write. */
const WRITER = () => path.basename(process.argv[1] || 'settle.js');
function appendJsonl(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = JSON.stringify(row) + '\n'; fs.appendFileSync(file, line);
  try { require('../provenance.js').appended(file, line, WRITER()); } catch (_) {}
  return row;
}
function writeJson(file, v) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const txt = JSON.stringify(v, null, 2) + '\n'; const t = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(3).toString('hex');
  fs.writeFileSync(t, txt); fs.renameSync(t, file);
  try { require('../provenance.js').wrote(file, txt, WRITER()); } catch (_) {}
  return file;
}
function args(argv) {
  const a = { _: [] }; const v = argv || process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    if (v[i].startsWith('--')) { const k = v[i].slice(2); const n = v[i + 1]; if (n === undefined || n.startsWith('--')) a[k] = true; else { a[k] = n; i++; } }
    else a._.push(v[i]);
  }
  return a;
}
function gate() { return require('../external-gate.js'); }
const out = (code, obj) => { console.log(JSON.stringify(obj, null, 2)); process.exit(code); };

module.exports = Object.assign({}, kit, { tool, override, CODE_ROOT, co, kit, work, appendJsonl, writeJson, sha256, readJson, ID_RE, partyPath, parties, emitEvent, commitments,
  commitment, transition, doers, stationReachable, selftest, args, gate, out });
