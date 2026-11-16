#!/usr/bin/env node
/* playbooks.js — situation -> procedure. Match rules over intake events choose a playbook; the chosen playbook creates
 * a commitment with the playbook's owner function and clocks.
 *
 * A playbook is company/work/playbooks/<id>.json (the rules) + <id>.md (the procedure the owner seat follows):
 *   { "id": "refund-request", "title": "Refund request from {{data.customer}}", "priority": 10,
 *     "match": { "source": "shop", "type": "refund.*", "where": [ { "path": "data.total", "op": "gt", "value": 0 } ] },
 *     "owner": "finance", "clocks": { "ackMinutes": 30, "dueMinutes": 1440 },
 *     "steps": ["check the order", "refund or refuse", "tell the customer"], "verify": null }
 * match: source / type are exact or a trailing-* prefix; where[] ops: eq ne gt gte lt lte exists missing contains
 * matches (regex). All must hold. The best match wins: highest priority, then the most conditions, then the id.
 * The tick reads events past a byte cursor (company/work/playbooks/cursor.json), matches each, creates the commitment
 * (key = "<source>:<event key>", so a replayed event dedupes) and logs company/work/playbooks/matches.jsonl.
 * Limits (kit.limits: company/state/modules/<id>/limits/ once the owner opens them; shipped closed): maxCommitmentsPerTick.
 *
 *   node company/tools/playbooks.js list [--json]
 *   node company/tools/playbooks.js check                         # every playbook file is well formed (exit 1 if not)
 *   node company/tools/playbooks.js match --event '<json>' [--json]
 *   node company/tools/playbooks.js run [--dry] [--json]          # what the tick does
 *   node company/tools/playbooks.js --selftest
 * Module: require('./playbooks.js') -> { load, match, run, validate }.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const LIB = [path.join(__dirname, 'lib'), path.join(__dirname, '..', '..', '..', 'company', 'tools', 'lib')].find(d => fs.existsSync(path.join(d, 'modkit.js')));
const co = require(path.join(LIB, 'company'));
const kit = require(path.join(LIB, 'modkit'));

const ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
const OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'exists', 'missing', 'contains', 'matches'];
const FUNCTIONS = ['ceo', 'people', 'tools', 'risk', 'floor', 'finance'];
const DIR = () => co.p('company', 'work', 'playbooks');
const CURSOR = () => path.join(DIR(), 'cursor.json');
const MATCHES = () => path.join(DIR(), 'matches.jsonl');
const EVENTS = () => co.p('company', 'work', 'intake', 'events.jsonl');

function validate(pb, file) {
  const f = [];
  if (!pb || typeof pb !== 'object') return [file + ': not a JSON object'];
  if (!ID_RE.test(String(pb.id))) f.push(file + ': id must match ' + ID_RE);
  if (file && pb.id + '.json' !== path.basename(file)) f.push(file + ': id ' + pb.id + ' does not equal the file name');
  if (!pb.title) f.push(file + ': title required');
  if (!pb.match || typeof pb.match !== 'object' || !(pb.match.source || pb.match.type || (pb.match.where || []).length)) f.push(file + ': match needs at least one of source, type, where');
  for (const w of (pb.match && pb.match.where) || []) {
    if (!w || typeof w.path !== 'string') f.push(file + ': where[].path required');
    else if (!OPS.includes(w.op)) f.push(file + ': where op ' + w.op + ' is not one of ' + OPS.join(' '));
    else if (w.op === 'matches') { try { new RegExp(w.value); } catch (_) { f.push(file + ': where regex does not compile'); } }
  }
  if (pb.owner && !FUNCTIONS.includes(pb.owner) && !co.crew()[pb.owner]) f.push(file + ': owner ' + pb.owner + ' is neither a function nor a seat');
  const c = pb.clocks || {};
  for (const k of ['ackMinutes', 'dueMinutes']) if (c[k] != null && !(Number(c[k]) > 0)) f.push(file + ': clocks.' + k + ' must be a positive number of minutes');
  if (fs.existsSync(path.join(DIR(), String(pb.id) + '.json')) && !fs.existsSync(path.join(DIR(), String(pb.id) + '.md'))) f.push(file + ': the procedure ' + pb.id + '.md is missing');
  return f;
}
function load() {
  let fl = []; try { fl = fs.readdirSync(DIR()).filter(f => /^[a-z][a-z0-9-]{1,39}\.json$/.test(f) && f !== 'cursor.json').sort(); } catch (_) {}
  const out = [], bad = [];
  for (const f of fl) { const pb = co.readJson(path.join(DIR(), f), null); const v = validate(pb, f); if (v.length) bad.push(...v); else out.push(pb); }
  return { playbooks: out, findings: bad };
}
const glob = (pat, v) => pat == null || (String(pat).endsWith('*') ? String(v || '').startsWith(String(pat).slice(0, -1)) : String(pat) === String(v));
function cond(w, ev) {
  const v = kit.dget(ev, w.path);
  switch (w.op) {
    case 'eq': return JSON.stringify(v) === JSON.stringify(w.value);
    case 'ne': return JSON.stringify(v) !== JSON.stringify(w.value);
    case 'gt': return Number(v) > Number(w.value); case 'gte': return Number(v) >= Number(w.value);
    case 'lt': return Number(v) < Number(w.value); case 'lte': return Number(v) <= Number(w.value);
    case 'exists': return v !== undefined && v !== null; case 'missing': return v === undefined || v === null;
    case 'contains': return Array.isArray(v) ? v.includes(w.value) : String(v == null ? '' : v).includes(String(w.value));
    case 'matches': try { return new RegExp(w.value).test(String(v == null ? '' : v)); } catch (_) { return false; }
  }
  return false;
}
function matchOne(pb, ev) { const m = pb.match || {}; return glob(m.source, ev.source) && glob(m.type, ev.type) && (m.where || []).every(w => cond(w, ev)); }
function match(ev, pbs) {
  pbs = pbs || load().playbooks;
  const hits = pbs.filter(pb => matchOne(pb, ev));
  const spec = pb => (pb.match.source ? 1 : 0) + (pb.match.type ? 1 : 0) + (pb.match.where || []).length;
  hits.sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0) || spec(b) - spec(a) || a.id.localeCompare(b.id));
  return hits[0] || null;
}
const fill = (tpl, ev) => String(tpl).replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_, p) => { const v = kit.dget(ev, p); return v == null ? '' : String(v).slice(0, 120); });

function run(o) {
  o = o || {};
  const log = o.log || (() => {});
  const commitments = o.commitments || kit.tool('commitments');
  if (!commitments) return { ok: false, error: 'the commitments module is not enabled (playbooks requires it)' };
  const { playbooks, findings } = load();
  for (const f of findings) log('PLAYBOOK BAD ' + f);
  const cur = co.readJson(CURSOR(), {}) || {};
  let size = 0; try { size = fs.statSync(EVENTS()).size; } catch (_) {}
  let off = Number(cur.offset) || 0; if (off > size) off = 0;   // the file was rotated: start over (creates dedupe)
  const max = kit.limit('playbooks', 'maxCommitmentsPerTick');
  const out = [];
  if (size <= off) return { ok: true, created: out, findings };
  const fd = fs.openSync(EVENTS(), 'r'); const buf = Buffer.alloc(size - off); fs.readSync(fd, buf, 0, buf.length, off); fs.closeSync(fd);
  const txt = buf.toString('utf8'); const lastNl = txt.lastIndexOf('\n');
  if (lastNl < 0) return { ok: true, created: out, findings };   // a half-written line: wait for it
  let consumed = 0, made = 0;
  for (const line of txt.slice(0, lastNl).split('\n')) {
    const bytes = Buffer.byteLength(line) + 1;
    if (!line.trim()) { consumed += bytes; continue; }
    let ev; try { ev = JSON.parse(line); } catch (_) { consumed += bytes; continue; }
    const pb = match(ev, playbooks);
    if (pb) {
      if (made >= max) { log('PLAYBOOKS held at maxCommitmentsPerTick ' + max); break; }   // the rest waits for the next tick
      const c = pb.clocks || {};
      const r = o.dry ? { ok: true, dry: true } : (() => { try { return commitments.create({ title: fill(pb.title, ev), key: ev.source + ':' + ev.key, owner: pb.owner || 'ceo', party: ev.party,
        ackBy: c.ackMinutes || 60, dueAt: c.dueMinutes || null, playbook: pb.id, verify: pb.verify || null, source: { event: ev.id, source: ev.source, type: ev.type }, by: 'playbooks', note: 'playbook ' + pb.id + ' matched event ' + ev.id, evidence: ['company/work/playbooks/' + pb.id + '.md'] }); } catch (e) { return { ok: false, error: e.message }; } })();
      if (!r.ok && /maxOpen/.test(r.error || '')) { log('PLAYBOOKS held: ' + r.error); break; }
      const row = { at: new Date().toISOString(), event: ev.id, playbook: pb.id, commitment: r.commitment ? r.commitment.id : null, dedupe: !!r.dedupe, error: r.error || null };
      if (!o.dry) kit.appendJsonl(MATCHES(), row);
      out.push(row); if (!r.dedupe) made++;
      log('PLAYBOOK ' + pb.id + ' <- ' + ev.source + '/' + ev.type + ' ' + ev.key + (row.commitment ? ' -> ' + row.commitment : '') + (row.error ? ' ERROR ' + row.error : ''));
    }
    consumed += bytes;
  }
  if (!o.dry) kit.writeJson(CURSOR(), { offset: off + consumed, at: new Date().toISOString() });
  return { ok: true, created: out, findings };
}

module.exports = { load, match, run, validate, OPS };

async function selftest(ok) {
  fs.mkdirSync(DIR(), { recursive: true });
  const write = (pb, md) => { kit.writeJson(path.join(DIR(), pb.id + '.json'), pb); if (md !== false) fs.writeFileSync(path.join(DIR(), pb.id + '.md'), '# ' + pb.title + '\n'); };
  write({ id: 'any-order', title: 'Order {{key}}', match: { source: 'shop', type: 'order.*' }, owner: 'finance', clocks: { ackMinutes: 15, dueMinutes: 120 } });
  write({ id: 'big-order', title: 'Big order {{data.total}}', priority: 5, match: { source: 'shop', type: 'order.created', where: [{ path: 'data.total', op: 'gte', value: 1000 }] }, owner: 'tools', clocks: { ackMinutes: 5, dueMinutes: 60 } });
  write({ id: 'broken', title: 'x', match: { where: [{ path: 'a', op: 'nope' }] } });
  write({ id: 'no-md', title: 'x', match: { source: 'x' } }, false);
  const { playbooks, findings } = load();
  ok('bad playbooks are reported, good ones load', playbooks.map(p => p.id).join() === 'any-order,big-order' && findings.some(f => /op nope/.test(f)) && findings.some(f => /no-md\.md is missing/.test(f)), findings);
  const ev = (key, type, total) => ({ id: 'ev-' + key, at: new Date().toISOString(), source: 'shop', type, key, data: { total }, receivedVia: 'test' });
  ok('a plain order matches the general playbook', (match(ev('1', 'order.created', 10)) || {}).id === 'any-order');
  ok('a big order picks the higher priority', (match(ev('2', 'order.created', 5000)) || {}).id === 'big-order');
  ok('prefix type match', (match(ev('3', 'order.refunded', 1)) || {}).id === 'any-order');
  ok('no match outside the rules', match(Object.assign(ev('4', 'order.created', 1), { source: 'other' })) === null);
  const intake = kit.tool('intake');
  for (const e of [ev('a', 'order.created', 10), ev('b', 'order.created', 2000), ev('c', 'ping', 0)]) intake.ingest(e);
  kit.setLimits(co.ROOT, 'commitments', { maxOpen: 10 });
  let r = run();
  ok('closed limit creates nothing and keeps the cursor', r.created.length === 0 && !(co.readJson(CURSOR(), {}) || {}).offset, r);
  kit.setLimits(co.ROOT, 'playbooks', { maxCommitmentsPerTick: 5 });
  r = run();
  const cm = kit.tool('commitments');
  const all = cm.list();
  ok('two commitments from two matching events', r.created.length === 2 && all.length === 2, r);
  const big = all.find(c => c.playbook === 'big-order');
  ok('owner function and clocks come from the playbook', big && big.owner === 'lead1' && big.ownerFunction === 'tools' && Date.parse(big.dueAt) - Date.parse(big.createdAt) === 3600000 && big.title === 'Big order 2000', big);
  ok('key is source:event key', big && big.key === 'shop:b');
  r = run();
  ok('cursor: a second run creates nothing', r.created.length === 0, r);
  fs.writeFileSync(CURSOR(), JSON.stringify({ offset: 0 }));
  r = run();
  ok('a replayed event dedupes', r.created.every(x => x.dedupe) && cm.list().length === 2, r);
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest') || argv[0] === 'selftest') { kit.runSelftest(__filename, 'playbooks', selftest); return; }
  const a = kit.args(argv);
  const out = (o, text) => console.log(a.json ? JSON.stringify(o, null, 2) : text);
  const cmd = a._[0];
  try {
    if (cmd === 'list') { const l = load(); out(l, l.playbooks.map(p => p.id + '  ' + (p.owner || 'ceo') + '  ' + JSON.stringify(p.match)).join('\n') || '(no playbooks)'); }
    else if (cmd === 'check') { const l = load(); for (const f of l.findings) console.log('  FAIL ' + f); console.log(l.playbooks.length + ' ok, ' + l.findings.length + ' finding(s)'); process.exit(l.findings.length ? 1 : 0); }
    else if (cmd === 'match') { const pb = match(JSON.parse(a.event || '{}')); out({ playbook: pb }, pb ? pb.id : '(no playbook matches)'); }
    else if (cmd === 'run') { const r = run({ dry: !!(a.dry || a['dry-run']), log: console.log }); out(r, (r.created || []).length + ' match(es)' + (r.error ? ' ' + r.error : '')); process.exit(r.ok ? 0 : 1); }
    else { console.error('usage: playbooks.js list|check|match|run|--selftest (see header)'); process.exit(2); }
  } catch (e) { console.error(e.message); process.exit(1); }
}
