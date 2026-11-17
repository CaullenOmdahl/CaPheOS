#!/usr/bin/env node
/* reports.js — periodic outcome reports per party: drafted from records, reviewed, sent only through the external gate.
 *
 *   node reports.js draft --party <id> --from YYYY-MM-DD --to YYYY-MM-DD [--template default]
 *        -> company/work/reports/<party>/<to>.md (+ .json, the data it was built from)
 *   node reports.js review --party <id> --file <draft.md> --by <seat> [--note ..]   a second pair of eyes; tied to the draft's digest
 *   node reports.js send --party <id> --file <draft.md> --target <prefix:id> --by <agent> [--category message|publish]
 *        external-gate.js check (category message or publish) + the module limit sendsPerDay; a changed draft needs a new review
 *   node reports.js tick [--dry]       draft what company/work/reports/schedule.json says is due ({"parties":{"<id>":{"every":"weekly|monthly","template":"default"}}})
 *   node reports.js --selftest
 *
 * Templates: company/work/reports/templates/<name>.md (the company's own) before modules/reports/templates/<name>.md.
 * Placeholders are {{dot.path}} into the data (company, party, partyName, from, to, generatedAt, commitments.*, verify.*,
 * events.*) plus the prebuilt {{commitments_table}} and {{verify_table}}. An unknown placeholder renders as "n/a".
 * Sending: nothing leaves without a gate row for that recipient AND an opened limit (shipped 0); the send is queued to
 * company/work/reports/outbox.jsonl for the transport adapter and recorded in company/work/reports/<party>/sent.jsonl.
 * Owner of this tool: the ceo function.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const S = require((() => { let d = __dirname; for (let i = 0; i < 6; i++, d = path.dirname(d)) { const f = path.join(d, 'company', 'tools', 'lib', 'settle.js'); if (fs.existsSync(f)) return f; } return path.join(__dirname, 'lib', 'settle.js'); })());
const co = S.co;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const RDIR = party => { if (!S.ID_RE.test(String(party || ''))) throw new Error('--party <id> is required'); return S.work('reports', party); };
let GATE_OPTS = null;   // selftest only

function template(name) {
  name = String(name || 'default'); if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new Error('bad template name');
  for (const f of [S.work('reports', 'templates', name + '.md'), path.join(S.CODE_ROOT, 'modules', 'reports', 'templates', name + '.md')]) { try { return fs.readFileSync(f, 'utf8'); } catch (_) {} }
  throw new Error('no template ' + name);
}
function data(party, from, to) {
  const a = Date.parse(from + 'T00:00:00Z'), b = Date.parse(to + 'T23:59:59.999Z');
  const inW = at => { const t = Date.parse(at); return t >= a && t <= b; };
  const cs = S.commitments({ archived: true }).filter(c => c.party === party && ((c.history || []).some(h => inW(h.at)) || inW(c.createdAt)));
  const vr = S.readJsonl(S.work('verify', 'results.jsonl')).filter(r => r.party === party && inW(r.at));
  const ev = S.readJsonl(S.work('intake', 'events.jsonl')).filter(e => e.party === party && inW(e.at));
  let pname = party; const P = S.tool('parties'); if (P && typeof P.get === 'function') { try { const p = P.get(party); if (p && p.name) pname = p.name; } catch (_) {} }
  const open = ['received', 'acknowledged', 'in_progress', 'done', 'breached'];
  return { company: co.config.name || 'The company', party, partyName: pname, from, to, generatedAt: new Date().toISOString(),
    commitments: { total: cs.length, verified: cs.filter(c => ['verified', 'closed'].includes(c.state)).length, open: cs.filter(c => open.includes(c.state)).length, breached: cs.filter(c => c.state === 'breached').length,
      rows: cs.map(c => ({ id: c.id, title: c.title, state: c.state, dueAt: c.dueAt || '' })) },
    verify: { pass: vr.filter(r => r.outcome === 'pass').length, fail: vr.filter(r => r.outcome === 'fail').length, pending: vr.filter(r => r.outcome === 'pending').length,
      rows: vr.map(r => ({ at: r.at, commitment: r.commitment, outcome: r.outcome })) },
    events: { total: ev.length } };
}
const cell = v => String(v == null ? '' : v).replace(/\|/g, '/').replace(/\n/g, ' ');
const table = (rows, cols) => rows.length ? '| ' + cols.join(' | ') + ' |\n|' + cols.map(() => '---').join('|') + '|\n' + rows.map(r => '| ' + cols.map(c => cell(r[c])).join(' | ') + ' |').join('\n') : '_None in this period._';
function render(tpl, d) {
  const ext = Object.assign({}, d, { commitments_table: table(d.commitments.rows, ['title', 'state', 'dueAt']), verify_table: table(d.verify.rows, ['at', 'commitment', 'outcome']) });
  return tpl.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (m, k) => { const v = S.dget(ext, k); return v == null || typeof v === 'object' ? 'n/a' : String(v); });
}
function draft(o) {
  if (!DAY.test(String(o.from || '')) || !DAY.test(String(o.to || ''))) throw new Error('--from and --to are YYYY-MM-DD');
  const dir = RDIR(o.party);
  S.partyPath(o.party);   // parties module refuses an unknown party
  const d = data(o.party, o.from, o.to);
  const md = render(template(o.template), d);
  const f = path.join(dir, o.to + '.md');
  if (!o.dry) { S.writeJson(path.join(dir, o.to + '.json'), d); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(f, md);
    S.appendJsonl(path.join(dir, 'drafts.jsonl'), { at: d.generatedAt, file: path.relative(co.ROOT, f), sha256: S.sha256(md), from: o.from, to: o.to, template: o.template || 'default' }); }
  return { ok: true, file: path.relative(co.ROOT, f), sha256: S.sha256(md), dry: !!o.dry };
}
function draftFile(party, file) {
  const dir = RDIR(party); const abs = path.resolve(co.ROOT, String(file || ''));
  if (!abs.startsWith(dir + path.sep) || !abs.endsWith('.md') || !fs.existsSync(abs)) throw new Error('--file must be a draft under company/work/reports/' + party + '/');
  return abs;
}
function review(o) {
  const abs = draftFile(o.party, o.file); if (!o.by || o.by === true) throw new Error('--by is required');
  const row = { at: new Date().toISOString(), file: path.relative(co.ROOT, abs), sha256: S.sha256(fs.readFileSync(abs)), by: String(o.by), note: String(o.note || '').slice(0, 400) };
  S.appendJsonl(path.join(RDIR(o.party), 'reviews.jsonl'), row);
  return row;
}
function send(o) {
  const abs = draftFile(o.party, o.file);
  const category = o.category || 'message';
  if (!['message', 'publish'].includes(category)) throw new Error('--category is message or publish');
  if (!o.target || !o.by || o.by === true) throw new Error('--target and --by are required');
  const dir = RDIR(o.party); const sha = S.sha256(fs.readFileSync(abs));
  const rv = S.readJsonl(path.join(dir, 'reviews.jsonl')).filter(r => r.sha256 === sha && r.by.toLowerCase() !== String(o.by).toLowerCase());
  if (!rv.length) throw new Error('refused: this draft (as it is now) has no review by a seat other than the sender (reports.js review)');
  const max = S.limit('reports', 'sendsPerDay');
  const today = new Date().toISOString().slice(0, 10);
  const sentToday = S.readJsonl(S.work('reports', 'outbox.jsonl')).filter(r => String(r.at).startsWith(today)).length;
  if (sentToday >= max) throw new Error('refused: limits sendsPerDay is ' + max + ' and ' + sentToday + ' went today (the owner opens this limit)');
  // idempotency key = this exact draft (digest) to this target: a retry after a crash is a gate duplicate, not a resend
  const idem = 'report:' + o.party + ':' + sha.slice(0, 32) + ':' + String(o.target);
  const g = S.gate().check({ category, target: String(o.target), agent: String(o.by), idem, note: 'report party:' + o.party + ' ' + path.basename(abs) + ' sha256:' + sha.slice(0, 16) }, GATE_OPTS || {});
  if (g.duplicate) throw new Error('duplicate: this draft already went to ' + o.target + ' (gate attempt ' + g.priorAttempt + '); not sent again');
  if (!g.allow) throw new Error('refused by the external gate: ' + g.reason);
  const row = { at: new Date().toISOString(), party: o.party, file: path.relative(co.ROOT, abs), sha256: sha, category, target: String(o.target), by: String(o.by), clearanceId: g.clearanceId, clearedBy: g.clearedBy, reviewedBy: rv[rv.length - 1].by, attemptId: g.attemptId || null };
  S.appendJsonl(S.work('reports', 'outbox.jsonl'), row);
  S.appendJsonl(path.join(dir, 'sent.jsonl'), row);
  if (g.attemptId && S.gate().recordSent) S.gate().recordSent({ attempt: g.attemptId, ref: 'reports outbox' });
  return row;
}
function due(every, last, now) {
  const d = new Date(now); const ymd = x => x.toISOString().slice(0, 10);
  if (every === 'monthly') { const to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)); const from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1)); return last && last >= ymd(to) ? null : { from: ymd(from), to: ymd(to) }; }
  const to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1)); const from = new Date(to.getTime() - 6 * 86400000);
  return last && Date.parse(last) > to.getTime() - 7 * 86400000 ? null : { from: ymd(from), to: ymd(to) };
}
function tick(o) {
  o = o || {}; const sch = S.readJson(S.work('reports', 'schedule.json'), {}) || {}; const out = [];
  for (const [party, cfg] of Object.entries(sch.parties || {})) {
    try {
      const last = (S.readJsonl(path.join(RDIR(party), 'drafts.jsonl')).slice(-1)[0] || {}).to;
      const w = due((cfg && cfg.every) || 'weekly', last, o.now || Date.now()); if (!w) continue;
      out.push(Object.assign({ party }, draft({ party, from: w.from, to: w.to, template: cfg && cfg.template, dry: o.dry })));
    } catch (e) { out.push({ party, ok: false, error: e.message }); }
  }
  return out;
}

function selftest() {
  return S.selftest(__filename, ok => {
    const throws = (fn, re) => { try { fn(); return 'no throw'; } catch (e) { return re.test(e.message) || e.message; } };
    S.override('parties', null);
    const at = '2026-03-03T10:00:00.000Z';
    S.writeJson(S.work('commitments', 'c-202603031000-000001.json'), { id: 'c-202603031000-000001', key: 'k', party: 'acme', title: 'Fix the | feed', state: 'verified', owner: 'sam', createdAt: at, history: [{ at, from: null, to: 'received', by: 'intake' }], evidence: [] });
    S.appendJsonl(S.work('verify', 'results.jsonl'), { at, commitment: 'c-202603031000-000001', party: 'acme', outcome: 'pass' });
    const d = draft({ party: 'acme', from: '2026-03-01', to: '2026-03-07' });
    const md = fs.readFileSync(path.join(co.ROOT, d.file), 'utf8');
    ok('draft renders the template with the records', /1 verified/.test(md) && /Fix the \/ feed/.test(md) && /1 passed/.test(md) && !/\{\{/.test(md), md.slice(0, 300));
    ok('draft keeps its data beside it', fs.existsSync(path.join(co.ROOT, d.file.replace(/\.md$/, '.json'))));
    ok('send without a review is refused', throws(() => send({ party: 'acme', file: d.file, target: 'email:ops@acme.example', by: 'alex' }), /no review/) === true);
    review({ party: 'acme', file: d.file, by: 'alex' });
    ok('a review by the sender does not count', throws(() => send({ party: 'acme', file: d.file, target: 'email:ops@acme.example', by: 'alex' }), /no review/) === true);
    review({ party: 'acme', file: d.file, by: 'kim' });
    ok('limit closed: refused even when reviewed', throws(() => send({ party: 'acme', file: d.file, target: 'email:ops@acme.example', by: 'alex' }), /sendsPerDay is 0/) === true);
    S.setLimits(co.ROOT, 'reports', { sendsPerDay: 5 });
    ok('no gate row for the recipient: refused by the external gate', throws(() => send({ party: 'acme', file: d.file, target: 'email:ops@acme.example', by: 'alex' }), /external gate/) === true);
    ok('the refusal is logged by the gate', S.readJsonl(S.work('external-actions.jsonl')).some(r => r.decision === 'refused' && /party:acme/.test(r.note)));
    GATE_OPTS = { guards: { externalActions: false } };   // the owner's switch off: gate logs and allows
    const s = send({ party: 'acme', file: d.file, target: 'email:ops@acme.example', by: 'alex' });
    ok('with the gate allowing, the send is queued and recorded', s.reviewedBy === 'kim' && S.readJsonl(S.work('reports', 'outbox.jsonl')).length === 1 && S.readJsonl(S.work('reports', 'acme', 'sent.jsonl')).length === 1);
    ok('the same draft to the same target again is a gate duplicate, not a resend', throws(() => send({ party: 'acme', file: d.file, target: 'email:ops@acme.example', by: 'alex' }), /duplicate/) === true && S.readJsonl(S.work('reports', 'outbox.jsonl')).length === 1);
    fs.appendFileSync(path.join(co.ROOT, d.file), '\nedited after review\n');
    ok('a draft changed after review needs a new review', throws(() => send({ party: 'acme', file: d.file, target: 'email:ops@acme.example', by: 'alex' }), /no review/) === true);
    ok('a file outside the party folder is refused', throws(() => review({ party: 'acme', file: 'company/work/reports/beta/x.md', by: 'kim' }), /must be a draft/) === true);
    S.writeJson(S.work('reports', 'schedule.json'), { parties: { acme: { every: 'weekly' } } });
    const t1 = tick({ now: Date.parse('2026-03-20T08:00:00Z') });
    ok('tick drafts the last full week', t1.length === 1 && /2026-03-19\.md$/.test(t1[0].file), t1);
    ok('tick does not redraft the same week', tick({ now: Date.parse('2026-03-21T08:00:00Z') }).length === 0);
  });
}

if (require.main === module) {
  const a = S.args(); const cmd = a._[0] || (a.selftest ? 'selftest' : '');
  try {
    if (cmd === 'selftest') selftest();
    else if (cmd === 'draft') S.out(0, draft({ party: a.party, from: a.from, to: a.to, template: a.template }));
    else if (cmd === 'review') S.out(0, review({ party: a.party, file: a.file, by: a.by, note: a.note }));
    else if (cmd === 'send') S.out(0, send({ party: a.party, file: a.file, target: a.target, by: a.by, category: a.category }));
    else if (cmd === 'tick') S.out(0, tick({ dry: !!a.dry }));
    else S.out(2, { ok: false, error: 'commands: draft, review, send, tick, --selftest' });
  } catch (e) { S.out(1, { ok: false, error: e.message }); }
}
module.exports = { draft, review, send, tick, render, data };
