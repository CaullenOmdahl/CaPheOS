#!/usr/bin/env node
/* scopes.js — per-party credentials: one secret per file, a scope record beside it, resolved only through secret().
 *
 * Outside parties hand the company access (an API key, a token). Each lives at secrets/parties/<party>/<name> (mode 0600,
 * enforced on every write and every read) with a scope record at company/work/scopes/<party>/<name>.json:
 *   { party, name, access: 'read-only'|'write', rotateBy: 'YYYY-MM-DD', owner: '<function or seat>', addedAt, addedBy, rotatedAt? }
 * The record holds no secret. Read-only is the default; a write-scope key needs the owner to open the module's limit
 * (limits.json maxWriteScopes > 0) and is handed only to a caller that asks for write: secret(party, name) asks for
 * read and is REFUSED a write-scope key, so a reader can never pick up the key that changes things by accident.
 *
 *   node scopes.js add --party <id> --name <name> --owner <fn|seat> --rotate-by YYYY-MM-DD [--access read-only|write] --by <seat>  (value on stdin)
 *   node scopes.js rotate --party <id> --name <name> --rotate-by YYYY-MM-DD --by <seat>        (new value on stdin)
 *   node scopes.js list [--party <id>] [--json]          records only, never values
 *   node scopes.js check [--days 14] [--json]            modes, missing files, rotation due -> intake events (deduped)
 *   node scopes.js --selftest
 *   module: const scopes = require('scopes.js'); scopes.secret(party, name, { want: 'read'|'write' }) -> string (throws)
 *
 * Fail closed: no record, unreadable record, a file wider than 0600, a missing file, an expired rotateBy for a write
 * key: all refuse. Owner of this tool: the risk function. Never prints a secret value.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const S = require((() => { let d = __dirname; for (let i = 0; i < 6; i++, d = path.dirname(d)) { const f = path.join(d, 'company', 'tools', 'lib', 'settle.js'); if (fs.existsSync(f)) return f; } return path.join(__dirname, 'lib', 'settle.js'); })());
const co = S.co;

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ACCESS = ['read-only', 'write'];
const secretFile = (party, name) => path.join(co.SECRETS_DIR, 'parties', party, name);
const recordFile = (party, name) => S.work('scopes', party, name + '.json');
function checkIds(party, name) {
  if (!S.ID_RE.test(String(party || ''))) throw new Error('bad --party "' + party + '"');
  if (!NAME_RE.test(String(name || '')) || name.endsWith('.json')) throw new Error('bad --name "' + name + '"');
}
function record(party, name) { checkIds(party, name); return S.readJson(recordFile(party, name), null); }
function records(party) {
  const out = []; let ps = []; try { ps = fs.readdirSync(S.work('scopes')); } catch (_) {}
  for (const p of ps) { if (party && p !== party) continue; let fs_ = []; try { fs_ = fs.readdirSync(S.work('scopes', p)); } catch (_) {}
    for (const f of fs_) if (f.endsWith('.json')) { const r = S.readJson(S.work('scopes', p, f), null); if (r) out.push(r); } }
  return out;
}
function modeOk(file) { const st = fs.statSync(file); return (st.mode & 0o077) === 0 ? null : 'mode ' + (st.mode & 0o777).toString(8) + ' is wider than 0600'; }
function writeSecret(party, name, value) {
  const f = secretFile(party, name);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(f), 0o700); fs.chmodSync(path.dirname(path.dirname(f)), 0o700); } catch (_) {}
  const t = f + '.tmp-' + process.pid;
  fs.writeFileSync(t, String(value).trim() + '\n', { mode: 0o600 }); fs.chmodSync(t, 0o600); fs.renameSync(t, f);
}

/* The one way a tool gets a party credential. */
function secret(party, name, o) {
  const want = (o && o.want) || 'read';
  const rec = record(party, name);
  if (!rec) throw new Error('no scope record for ' + party + '/' + name + ' (scopes.js add); refused');
  if (!ACCESS.includes(rec.access)) throw new Error('scope record ' + party + '/' + name + ' has no valid access; refused');
  if (want === 'read' && rec.access === 'write') throw new Error(party + '/' + name + ' is a write-scope key and the caller asked for read; refused (ask with { want: "write" })');
  if (want === 'write' && rec.access !== 'write') throw new Error(party + '/' + name + ' is read-only; refused');
  if (want === 'write' && rec.rotateBy && Date.parse(rec.rotateBy + 'T23:59:59Z') < Date.now()) throw new Error(party + '/' + name + ' is past its rotate-by date ' + rec.rotateBy + '; a write key is not handed out until rotated');
  const f = secretFile(party, name);
  if (!fs.existsSync(f)) throw new Error('secrets/parties/' + party + '/' + name + ' is missing; refused');
  const bad = modeOk(f); if (bad) throw new Error('secrets/parties/' + party + '/' + name + ': ' + bad + '; refused (chmod 600)');
  const v = fs.readFileSync(f, 'utf8').trim();
  if (!v) throw new Error('secrets/parties/' + party + '/' + name + ' is empty; refused');
  return v;
}

function add(o) {
  checkIds(o.party, o.name);
  const access = o.access || 'read-only';
  if (!ACCESS.includes(access)) throw new Error('--access is read-only or write');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(o.rotateBy || ''))) throw new Error('--rotate-by YYYY-MM-DD is required');
  if (!o.owner || o.owner === true) throw new Error('--owner <function or seat> is required');
  if (!o.by || o.by === true) throw new Error('--by is required');
  if (!String(o.value || '').trim()) throw new Error('no secret value on stdin');
  if (access === 'write') {
    const max = S.limit('scopes', 'maxWriteScopes');
    const have = records().filter(r => r.access === 'write' && !(r.party === o.party && r.name === o.name)).length;
    if (have >= max) throw new Error('write-scope keys are closed: limits maxWriteScopes is ' + max + ' and ' + have + ' are held (the owner opens this limit)');
  }
  writeSecret(o.party, o.name, o.value);
  const rec = { party: o.party, name: o.name, access, rotateBy: o.rotateBy, owner: String(o.owner), addedAt: new Date().toISOString(), addedBy: String(o.by) };
  S.writeJson(recordFile(o.party, o.name), rec);
  S.appendJsonl(S.work('scopes', 'log.jsonl'), { at: rec.addedAt, act: 'add', party: o.party, name: o.name, access, by: rec.addedBy });
  return rec;
}
function rotate(o) {
  const rec = record(o.party, o.name); if (!rec) throw new Error('no scope record for ' + o.party + '/' + o.name);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(o.rotateBy || ''))) throw new Error('--rotate-by YYYY-MM-DD is required');
  if (!String(o.value || '').trim()) throw new Error('no new value on stdin');
  writeSecret(o.party, o.name, o.value);
  rec.rotateBy = o.rotateBy; rec.rotatedAt = new Date().toISOString(); rec.rotatedBy = String(o.by || 'unknown');
  S.writeJson(recordFile(o.party, o.name), rec);
  S.appendJsonl(S.work('scopes', 'log.jsonl'), { at: rec.rotatedAt, act: 'rotate', party: o.party, name: o.name, by: rec.rotatedBy });
  return rec;
}
/* modes, presence, rotation: findings plus one intake event per due rotation (deduped on party/name/rotateBy) */
function check(o) {
  const days = Number((o && o.days) || 14); const now = (o && o.now) || Date.now();
  const findings = []; const events = [];
  for (const r of records()) {
    const f = secretFile(r.party, r.name);
    if (!fs.existsSync(f)) findings.push({ party: r.party, name: r.name, problem: 'secret file missing' });
    else { const b = modeOk(f); if (b) { findings.push({ party: r.party, name: r.name, problem: b }); try { fs.chmodSync(f, 0o600); } catch (_) {} } }
    const due = Date.parse(r.rotateBy + 'T00:00:00Z');
    if (!Number.isFinite(due)) { findings.push({ party: r.party, name: r.name, problem: 'rotateBy unreadable' }); continue; }
    const left = Math.floor((due - now) / 86400000);
    if (left <= days) {
      const ev = S.emitEvent({ source: 'scopes', type: left < 0 ? 'rotation-overdue' : 'rotation-due', key: 'scopes:rotation:' + r.party + ':' + r.name + ':' + r.rotateBy + (left < 0 ? ':overdue' : ''),
        party: r.party, data: { name: r.name, rotateBy: r.rotateBy, daysLeft: left, owner: r.owner, access: r.access }, receivedVia: 'scopes.check' });
      events.push({ party: r.party, name: r.name, daysLeft: left, duplicate: !!ev.duplicate });
    }
  }
  return { ok: !findings.length, findings, events };
}

function readStdin() { try { return fs.readFileSync(0, 'utf8'); } catch (_) { return ''; } }

function selftest() {
  return S.selftest(__filename, ok => {
    const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };
    const r = add({ party: 'acme', name: 'api', owner: 'risk', rotateBy: '2099-01-01', by: 'Alex', value: 'k-read' });
    ok('add read-only by default', r.access === 'read-only');
    ok('secret file is 0600', (fs.statSync(secretFile('acme', 'api')).mode & 0o777) === 0o600);
    ok('record holds no value', !JSON.stringify(S.readJson(recordFile('acme', 'api'), {})).includes('k-read'));
    ok('secret(read) returns the value', secret('acme', 'api') === 'k-read');
    ok('secret(write) on a read-only key refused', throws(() => secret('acme', 'api', { want: 'write' }), /read-only/));
    ok('write scope refused while limit closed', throws(() => add({ party: 'acme', name: 'admin', access: 'write', owner: 'risk', rotateBy: '2099-01-01', by: 'Alex', value: 'k-w' }), /closed/));
    S.setLimits(co.ROOT, 'scopes', { maxWriteScopes: 1 });
    add({ party: 'acme', name: 'admin', access: 'write', owner: 'risk', rotateBy: '2099-01-01', by: 'Alex', value: 'k-w' });
    ok('write-scope key refused to a caller asking read', throws(() => secret('acme', 'admin'), /write-scope key and the caller asked for read/));
    ok('write-scope key handed to a caller asking write', secret('acme', 'admin', { want: 'write' }) === 'k-w');
    ok('second write key over the limit refused', throws(() => add({ party: 'acme', name: 'admin2', access: 'write', owner: 'risk', rotateBy: '2099-01-01', by: 'Alex', value: 'x' }), /closed/));
    fs.chmodSync(secretFile('acme', 'api'), 0o644);
    ok('a file wider than 0600 is refused on read', throws(() => secret('acme', 'api'), /wider than 0600/));
    ok('unknown key refused', throws(() => secret('acme', 'nope'), /no scope record/));
    ok('bad party id refused', throws(() => secret('../x', 'api'), /bad --party/));
    add({ party: 'beta', name: 'feed', owner: 'risk', rotateBy: '2000-01-01', by: 'Alex', value: 'old' });
    const c = check({});
    ok('check fixes and reports the wide mode', c.findings.some(f => /wider/.test(f.problem)) && (fs.statSync(secretFile('acme', 'api')).mode & 0o777) === 0o600);
    ok('check emits a rotation-overdue event', c.events.some(e => e.party === 'beta' && e.daysLeft < 0));
    const ev = S.readJsonl(S.work('intake', 'events.jsonl')).filter(e => e.source === 'scopes');
    ok('event has the Event shape', ev.length === 1 && ev[0].id && ev[0].at && ev[0].key && ev[0].party === 'beta' && ev[0].receivedVia);
    check({});
    ok('rotation events are deduped', S.readJsonl(S.work('intake', 'events.jsonl')).filter(e => e.source === 'scopes').length === 1);
    rotate({ party: 'beta', name: 'feed', rotateBy: '2099-06-01', by: 'Alex', value: 'new' });
    ok('rotate replaces the value and the date', secret('beta', 'feed') === 'new' && record('beta', 'feed').rotateBy === '2099-06-01');
    ok('list never prints values', !JSON.stringify(records()).match(/k-read|k-w|new"/));
  });
}

if (require.main === module) {
  const a = S.args();
  const cmd = a._[0] || (a.selftest ? 'selftest' : '');
  try {
    if (cmd === 'selftest') selftest();
    else if (cmd === 'add') S.out(0, { ok: true, record: add({ party: a.party, name: a.name, access: a.access, rotateBy: a['rotate-by'], owner: a.owner, by: a.by, value: readStdin() }) });
    else if (cmd === 'rotate') S.out(0, { ok: true, record: rotate({ party: a.party, name: a.name, rotateBy: a['rotate-by'], by: a.by, value: readStdin() }) });
    else if (cmd === 'list') { const l = records(a.party); if (a.json) S.out(0, l); for (const r of l) console.log(r.party + '/' + r.name + '  ' + r.access + '  rotate by ' + r.rotateBy + '  owner ' + r.owner); }
    else if (cmd === 'check') { const r = check({ days: a.days }); S.out(r.ok ? 0 : 1, r); }
    else S.out(2, { ok: false, error: 'commands: add, rotate, list, check, --selftest' });
  } catch (e) { S.out(1, { ok: false, error: e.message }); }
}
module.exports = { secret, record, records, add, rotate, check, stampFile: () => S.work('scopes', 'last-check.txt') };
