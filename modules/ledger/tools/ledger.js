#!/usr/bin/env node
/* ledger.js — the company's revenue ledger: invoices, receipts, payouts and credit notes, append-only and hash-chained.
 *
 * Separate from AI spend on purpose (pacer/budget numbers never share a file with revenue). One file,
 * company/work/ledger/ledger.jsonl; each row carries seq, prev (the previous row's hash) and hash = sha256(prev + row).
 * Nothing is ever edited: a wrong invoice is answered with a credit note, never a rewrite.
 *
 *   node ledger.js invoice --party <id> --lines <commitment>=<amount>[,...] --by <seat> [--due YYYY-MM-DD] [--note ..]
 *        only delivered commitments (verified or closed) of that party, each invoiced once
 *   node ledger.js send --invoice <id> --target <prefix:id> --by <agent>
 *        REFUSED until the owner sets limits currency and opens maxInvoiceTotal/sendsPerDay, and the external gate
 *        (category message) clears that recipient; then queued to company/work/ledger/outbox.jsonl
 *   node ledger.js receipt --invoice <id> --amount <n> --by <seat> [--ref <bank ref>]
 *   node ledger.js credit --invoice <id> --amount <n> --reason "<why>" --by <seat>
 *   node ledger.js payout --to <prefix:id> --amount <n> --reason "<why>" --by <agent> [--party <id>]   (external gate category spend)
 *   node ledger.js reconcile --by <seat> [--party <id>]   refuses the seat that issued any invoice in scope
 *   node ledger.js summary [--json]                       revenue by party; writes company/work/ledger/receivables.json (panel)
 *   node ledger.js verify [--full]                        verify the hash chain from the last anchor (--full: from the first row); exit 1 if broken
 *   node ledger.js check                                  the same as verify
 *   node ledger.js --selftest
 * Owner of this tool: the finance function. Amounts are numbers in the one currency the owner sets (limits currency).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const SETTLE = (() => { let d = __dirname; for (let i = 0; i < 6; i++, d = path.dirname(d)) { const f = path.join(d, 'company', 'tools', 'lib', 'settle.js'); if (fs.existsSync(f)) return f; } return path.join(__dirname, 'lib', 'settle.js'); })();
const S = require(SETTLE);
const B = require(path.join(path.dirname(SETTLE), 'bounded.js'));
const co = S.co;
const LEDGER = () => S.work('ledger', 'ledger.jsonl');
const RECV = () => S.work('ledger', 'receivables.json');
const OUTBOX = () => S.work('ledger', 'outbox.jsonl');
let GATE_OPTS = null;   // selftest only
const money = n => Math.round(Number(n) * 100) / 100;
const amountOf = v => { const n = Number(v); if (!Number.isFinite(n) || n <= 0) throw new Error('amount must be a positive number'); return money(n); };
const need = (o, k) => { if (!o[k] || o[k] === true) throw new Error('--' + k + ' is required'); return String(o[k]); };

function rows() { return S.readJsonl(LEDGER()); }
function hashOf(r) { const x = Object.assign({}, r); delete x.hash; return S.sha256(String(r.prev || '') + JSON.stringify(x)); }
// the newest row, read from the end of the file (an append never reads the whole ledger)
function lastRow() { const l = B.tailLines(LEDGER(), 1)[0]; try { return l ? JSON.parse(l) : null; } catch (_) { return rows().pop() || null; } }
function append(row) {
  const last = lastRow();
  const r = Object.assign({ seq: last ? last.seq + 1 : 1, at: new Date().toISOString() }, row, { prev: last ? last.hash : null });
  r.hash = hashOf(r);
  S.appendJsonl(LEDGER(), r);
  return r;
}
/* The chain is verified from the last verified anchor forward: company/state/ledger-anchor.json holds {seq, hash, offset}
 * of the newest row a verify passed. The tick checks that row is still at its byte offset with its hash, then every row
 * after it (seq, prev, hash) and moves the anchor. `ledger.js verify --full` (and reconcile) checks every row from the
 * first. Rewriting a row before the anchor is caught by the full verify and, within one dispatcher tick, by locked-watch
 * (ledger.jsonl is a tool-only append-only meter: history before its last check may not change). */
const ANCHOR = () => co.p('company', 'state', 'ledger-anchor.json');
function checkRows(list, prevHash, firstSeq, problems) {
  let prev = prevHash;
  list.forEach((r, i) => {
    const n = firstSeq + i;
    if (r.seq !== n) problems.push('row ' + n + ': seq ' + r.seq);
    if ((r.prev || null) !== prev) problems.push('row ' + n + ': prev does not match the row before');
    if (hashOf(r) !== r.hash) problems.push('row ' + n + ': hash does not match its content');
    prev = r.hash;
  });
}
function chain(opt) {
  const o = opt || {}; const file = LEDGER(); const problems = [];
  let size = 0; try { size = fs.statSync(file).size; } catch (_) { return { ok: true, rows: 0, problems, full: true }; }
  const a = o.full ? null : S.readJson(ANCHOR(), null);
  let start = 0, prev = null, firstSeq = 1, mode = 'full';
  if (a && Number.isFinite(a.offset) && a.offset > 0 && a.seq > 0) {
    if (a.offset > size) return { ok: false, rows: null, problems: ['the ledger is shorter (' + size + ' bytes) than its anchor at row ' + a.seq + ' (' + a.offset + ' bytes): rows were removed'], from: a.seq };
    const back = Math.min(a.offset, 1 << 20); const buf = Buffer.alloc(back); const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, back, a.offset - back); } finally { fs.closeSync(fd); }
    const t = buf.toString('utf8'); const lines = t.replace(/\n$/, '').split('\n'); let row = null; try { row = JSON.parse(lines[lines.length - 1]); } catch (_) {}
    if (!t.endsWith('\n') || !row || row.seq !== a.seq || row.hash !== a.hash || hashOf(row) !== row.hash) return { ok: false, rows: null, problems: ['row ' + a.seq + ' is no longer what the anchor recorded at byte ' + a.offset + ': history before the anchor changed (run `ledger.js verify --full`)'], from: a.seq };
    start = a.offset; prev = a.hash; firstSeq = a.seq + 1; mode = 'from-anchor';
  }
  const len = size - start; const buf = Buffer.alloc(len); const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
  const txt = buf.toString('utf8'); const end = txt.lastIndexOf('\n') + 1;
  const list = []; for (const l of txt.slice(0, end).split('\n')) { if (!l.trim()) continue; try { list.push(JSON.parse(l)); } catch (_) { list.push({ _bad: true }); } }
  checkRows(list, prev, firstSeq, problems);
  const total = firstSeq - 1 + list.length;
  if (!problems.length && list.length && !o.noAnchor) { const last = list[list.length - 1]; try { S.writeJson(ANCHOR(), { seq: last.seq, hash: last.hash, offset: start + Buffer.byteLength(txt.slice(0, end)), at: new Date().toISOString() }); } catch (_) {} }
  return { ok: !problems.length, rows: total, problems, mode, checked: list.length, from: firstSeq - 1 };
}
function invoices() {
  const inv = {};
  for (const r of rows()) {
    if (r.type === 'invoice') inv[r.invoice] = Object.assign({}, r, { credited: 0, received: 0, sent: [] });
    const i = inv[r.invoice]; if (!i || r.type === 'invoice') continue;
    if (r.type === 'credit-note') i.credited = money(i.credited + r.amount);
    if (r.type === 'receipt') i.received = money(i.received + r.amount);
    if (r.type === 'invoice-sent') i.sent.push({ at: r.at, target: r.target });
  }
  for (const i of Object.values(inv)) i.outstanding = money(i.total - i.credited - i.received);
  return inv;
}

function invoice(o) {
  const party = need(o, 'party'); const by = need(o, 'by');
  if (!S.ID_RE.test(party)) throw new Error('bad --party');
  const lines = String(need(o, 'lines')).split(',').map(x => x.trim()).filter(Boolean).map(x => { const [c, a] = x.split('='); return { commitment: c, amount: amountOf(a) }; });
  const billed = new Set(); for (const i of Object.values(invoices())) for (const l of i.lines || []) if (i.credited < i.total) billed.add(l.commitment);
  for (const l of lines) {
    const c = S.commitment(l.commitment);
    if (!c) throw new Error('no commitment ' + l.commitment);
    if (c.party !== party) throw new Error(l.commitment + ' belongs to ' + (c.party || 'no party') + ', not ' + party);
    if (!['verified', 'closed'].includes(c.state)) throw new Error(l.commitment + ' is ' + c.state + '; only delivered (verified or closed) work is invoiced');
    if (billed.has(l.commitment)) throw new Error(l.commitment + ' is already on an invoice (credit it first)');
    l.title = c.title;
  }
  const currency = String(S.limits('ledger').currency || '') || null;
  return append({ type: 'invoice', invoice: S.newId('inv'), party, lines, total: money(lines.reduce((s, l) => s + l.amount, 0)), currency, dueAt: o.due || null, by, note: o.note || '' });
}
function findInv(id) { const i = invoices()[id]; if (!i) throw new Error('no invoice ' + id); return i; }
function send(o) {
  const i = findInv(need(o, 'invoice')); const target = need(o, 'target'); const by = need(o, 'by');
  const L = S.limits('ledger');
  if (!L.currency || typeof L.currency !== 'string') throw new Error('refused: the owner has not set the ledger currency (limits currency is empty)');
  if (i.currency !== L.currency) throw new Error('refused: invoice ' + i.invoice + ' was issued in ' + (i.currency || 'no currency') + '; credit it and issue it again in ' + L.currency);
  const max = S.limit('ledger', 'maxInvoiceTotal'); if (i.total > max) throw new Error('refused: total ' + i.total + ' is over limits maxInvoiceTotal ' + max);
  const perDay = S.limit('ledger', 'sendsPerDay'); const today = new Date().toISOString().slice(0, 10);
  const n = S.readJsonl(OUTBOX()).filter(r => String(r.at).startsWith(today)).length; if (n >= perDay) throw new Error('refused: limits sendsPerDay is ' + perDay + ' and ' + n + ' went today');
  if (i.outstanding <= 0) throw new Error('refused: invoice ' + i.invoice + ' has nothing outstanding');
  // idempotency key = what is sent (this invoice, as it stands, to this recipient): a retry after a crash between the
  // gate's allow and the outbox row is answered duplicate by the gate and nothing is queued twice
  const idem = o.idem || ('invoice:' + i.invoice + ':' + i.total + ':' + target);
  const g = S.gate().check({ category: 'message', target, agent: by, idem, note: 'invoice ' + i.invoice + ' party:' + i.party + ' total ' + i.total + ' ' + i.currency }, GATE_OPTS || {});
  if (g.duplicate) throw new Error('duplicate: invoice ' + i.invoice + ' already went to ' + target + ' (gate attempt ' + g.priorAttempt + '); not sent again');
  if (!g.allow) throw new Error('refused by the external gate: ' + g.reason);
  if (CRASH_AFTER_GATE) throw new Error('simulated crash after the gate allowed');   // selftest only
  const r = append({ type: 'invoice-sent', invoice: i.invoice, party: i.party, target, by, clearanceId: g.clearanceId, clearedBy: g.clearedBy, attemptId: g.attemptId || null });
  S.appendJsonl(OUTBOX(), { at: r.at, invoice: i.invoice, party: i.party, target, total: i.total, currency: i.currency, lines: i.lines, ledgerSeq: r.seq, attemptId: g.attemptId || null });
  if (g.attemptId && S.gate().recordSent) S.gate().recordSent({ attempt: g.attemptId, ref: 'ledger seq ' + r.seq });
  return r;
}
function receipt(o) {
  const i = findInv(need(o, 'invoice')); const amount = amountOf(o.amount);
  if (amount > i.outstanding) throw new Error('receipt ' + amount + ' is more than the outstanding ' + i.outstanding + ' (record the overpayment as a note to finance)');
  return append({ type: 'receipt', invoice: i.invoice, party: i.party, amount, ref: o.ref || '', by: need(o, 'by') });
}
function credit(o) {
  const i = findInv(need(o, 'invoice')); const amount = amountOf(o.amount);
  if (amount > money(i.total - i.credited)) throw new Error('credit ' + amount + ' is more than the uncredited ' + money(i.total - i.credited));
  return append({ type: 'credit-note', invoice: i.invoice, party: i.party, amount, reason: need(o, 'reason'), by: need(o, 'by') });
}
function payout(o) {
  const to = need(o, 'to'); const amount = amountOf(o.amount); const by = need(o, 'by'); const reason = need(o, 'reason');
  if (!S.limits('ledger').currency) throw new Error('refused: the owner has not set the ledger currency');
  // idempotency key: --idem, else derived from what is paid (to, amount, currency, reason, party); spend keys never expire,
  // so a genuinely repeated identical payout needs its own --idem
  const idem = o.idem || ('payout:' + S.sha256([to, amount, S.limits('ledger').currency, reason, o.party || ''].join('|')).slice(0, 32));
  const g = S.gate().check({ category: 'spend', target: to, agent: by, idem, note: 'payout ' + amount + (o.party ? ' party:' + o.party : '') + ': ' + reason }, GATE_OPTS || {});
  if (g.duplicate) throw new Error('duplicate: this payout already went out (gate attempt ' + g.priorAttempt + '); pass a distinct --idem for a genuinely new one');
  if (!g.allow) throw new Error('refused by the external gate: ' + g.reason);
  const r = append({ type: 'payout', party: o.party || null, to, amount, currency: S.limits('ledger').currency, reason, by, clearanceId: g.clearanceId, attemptId: g.attemptId || null, idem });
  if (g.attemptId && S.gate().recordSent) S.gate().recordSent({ attempt: g.attemptId, ref: 'ledger seq ' + r.seq });
  return r;
}
function reconcile(o) {
  const by = need(o, 'by'); const party = o.party && o.party !== true ? String(o.party) : null;
  const inv = Object.values(invoices()).filter(i => !party || i.party === party);
  const mine = inv.filter(i => String(i.by).toLowerCase() === by.toLowerCase());
  if (mine.length) throw new Error('refused: ' + by + ' issued ' + mine.map(i => i.invoice).join(', ') + '; reconcile is done by a seat other than the one that invoiced');
  const c = chain({ full: true }); const findings = c.problems.slice();
  const ids = new Set(inv.map(i => i.invoice));
  for (const r of rows()) if (['receipt', 'credit-note', 'invoice-sent'].includes(r.type) && !invoices()[r.invoice]) findings.push(r.type + ' seq ' + r.seq + ' names unknown invoice ' + r.invoice);
  for (const i of inv) if (i.outstanding < 0) findings.push(i.invoice + ' is overpaid/overcredited by ' + -i.outstanding);
  return append({ type: 'reconcile', party, by, invoices: [...ids], ok: !findings.length, findings: findings.slice(0, 50), chainRows: c.rows });
}
function summary() {
  const inv = Object.values(invoices()); const by = {};
  const P = p => (by[p] = by[p] || { party: p, invoiced: 0, credited: 0, revenue: 0, received: 0, outstanding: 0, payouts: 0 });
  for (const i of inv) { const s = P(i.party); s.invoiced = money(s.invoiced + i.total); s.credited = money(s.credited + i.credited); s.received = money(s.received + i.received); s.outstanding = money(s.outstanding + i.outstanding); s.revenue = money(s.invoiced - s.credited); }
  for (const r of rows()) if (r.type === 'payout') { const s = P(r.party || '(none)'); s.payouts = money(s.payouts + r.amount); }
  const now = Date.now();
  const receivables = inv.filter(i => i.outstanding > 0).map(i => ({ invoice: i.invoice, party: i.party, issued: i.at, due: i.dueAt || '', total: i.total, outstanding: i.outstanding, currency: i.currency || '',
    sent: i.sent.length > 0, ageDays: Math.floor((now - Date.parse(i.at)) / 86400000), overdue: !!(i.dueAt && Date.parse(i.dueAt + 'T23:59:59Z') < now) })).sort((a, b) => String(a.issued).localeCompare(String(b.issued)));
  const tot = Object.values(by).reduce((t, s) => { for (const k of ['invoiced', 'credited', 'revenue', 'received', 'outstanding', 'payouts']) t[k] = money((t[k] || 0) + s[k]); return t; }, {});
  const out = { at: new Date().toISOString(), currency: S.limits('ledger').currency || null, totals: tot, byParty: Object.values(by), receivables, chain: chain().ok };
  S.writeJson(RECV(), out);
  return out;
}

let CRASH_AFTER_GATE = false;
function selftest() {
  return S.selftest(__filename, ok => {
    const throws = (fn, re) => { try { fn(); return 'no throw'; } catch (e) { return re.test(e.message) || e.message; } };
    S.override('parties', null);
    const mk = (n, state, party) => { const id = 'c-202603010000-00000' + n; S.writeJson(S.work('commitments', id + '.json'), { id, key: id, party: party || 'acme', title: 'job ' + n, state, owner: 'sam', createdAt: '2026-03-01T00:00:00Z', history: [], evidence: [] }); return id; };
    const c1 = mk(1, 'verified'), c2 = mk(2, 'closed'), c3 = mk(3, 'in_progress'), c4 = mk(4, 'verified', 'beta');
    ok('undelivered work is not invoiced', throws(() => invoice({ party: 'acme', lines: c3 + '=10', by: 'sam' }), /only delivered/) === true);
    ok('another party\'s commitment is refused', throws(() => invoice({ party: 'acme', lines: c4 + '=10', by: 'sam' }), /belongs to beta/) === true);
    const inv = invoice({ party: 'acme', lines: c1 + '=100,' + c2 + '=50.5', by: 'sam', due: '2026-03-31' });
    ok('invoice from delivered commitments', inv.total === 150.5 && inv.lines.length === 2 && inv.seq === 1 && inv.currency === null);
    ok('a commitment is invoiced once', throws(() => invoice({ party: 'acme', lines: c1 + '=5', by: 'sam' }), /already on an invoice/) === true);
    ok('send refused: currency not set (limits closed)', throws(() => send({ invoice: inv.invoice, target: 'email:ap@acme.example', by: 'sam' }), /currency/) === true);
    S.setLimits(co.ROOT, 'ledger', { currency: 'EUR', maxInvoiceTotal: 1000, sendsPerDay: 3 });
    ok('an invoice issued before the currency was set is not sent', throws(() => send({ invoice: inv.invoice, target: 'email:ap@acme.example', by: 'sam' }), /credit it and issue it again/) === true);
    credit({ invoice: inv.invoice, amount: 150.5, reason: 'reissue in EUR', by: 'sam' });
    const inv2 = invoice({ party: 'acme', lines: c1 + '=100,' + c2 + '=50.5', by: 'sam' });
    ok('after a full credit the work can be invoiced again', inv2.currency === 'EUR');
    ok('send refused: the external gate has no row for the recipient', throws(() => send({ invoice: inv2.invoice, target: 'email:ap@acme.example', by: 'sam' }), /external gate/) === true);
    GATE_OPTS = { guards: { externalActions: false } };
    const s = send({ invoice: inv2.invoice, target: 'email:ap@acme.example', by: 'sam' });
    ok('with the gate allowing, the invoice is queued and the send is a ledger row', s.type === 'invoice-sent' && S.readJsonl(OUTBOX()).length === 1);
    ok('a receipt over the outstanding is refused', throws(() => receipt({ invoice: inv2.invoice, amount: 500, by: 'kim' }), /more than the outstanding/) === true);
    receipt({ invoice: inv2.invoice, amount: 100, by: 'kim', ref: 'bank-1' });
    ok('reconcile refuses the seat that invoiced', throws(() => reconcile({ by: 'sam' }), /other than the one that invoiced/) === true);
    const rc = reconcile({ by: 'kim' });
    ok('reconcile by another seat passes and is recorded', rc.ok && rc.type === 'reconcile', rc.findings);
    payout({ to: 'bank:contractor-1', amount: 20, reason: 'subcontract', by: 'alex', party: 'acme' });
    const sm = summary();
    ok('summary: revenue = invoiced - credits; outstanding; payouts', sm.totals.invoiced === 301 && sm.totals.credited === 150.5 && sm.totals.revenue === 150.5 && sm.totals.received === 100 && sm.totals.outstanding === 50.5 && sm.totals.payouts === 20, sm.totals);
    ok('receivables.json lists the open invoice for the panel', S.readJson(RECV(), {}).receivables.length === 1 && S.readJson(RECV(), {}).receivables[0].outstanding === 50.5);
    ok('hash chain verifies', chain().ok && chain().rows === 7, chain());
    // the same side effect twice: a re-send of the same invoice is a gate duplicate; a crash between the gate's allow
    // and the outbox row, then a retry, sends nothing twice
    ok('re-sending the same invoice to the same recipient is refused as a duplicate', throws(() => send({ invoice: inv2.invoice, target: 'email:ap@acme.example', by: 'sam' }), /duplicate/) === true && S.readJsonl(OUTBOX()).length === 1);
    const c5 = mk(5, 'verified'); const inv3 = invoice({ party: 'acme', lines: c5 + '=10', by: 'sam' });
    CRASH_AFTER_GATE = true; const crashed = throws(() => send({ invoice: inv3.invoice, target: 'email:ap@acme.example', by: 'sam' }), /simulated crash/); CRASH_AFTER_GATE = false;
    ok('crash after the gate allowed, before the send was recorded: nothing queued', crashed === true && S.readJsonl(OUTBOX()).length === 1);
    ok('the retry is answered duplicate (prior attempt id), still nothing sent twice', throws(() => send({ invoice: inv3.invoice, target: 'email:ap@acme.example', by: 'sam' }), /duplicate.*att-/) === true && S.readJsonl(OUTBOX()).length === 1);
    ok('a retried payout is a duplicate', throws(() => payout({ to: 'bank:contractor-1', amount: 20, reason: 'subcontract', by: 'alex', party: 'acme' }), /duplicate/) === true && rows().filter(r => r.type === 'payout').length === 1);
    chain(); const anc = S.readJson(ANCHOR(), null);
    ok('a verify records its anchor {seq, hash, offset}', anc && anc.seq === rows().length && anc.offset === fs.statSync(LEDGER()).size, anc);
    receipt({ invoice: inv2.invoice, amount: 1, by: 'kim', ref: 'bank-2' });
    const inc = chain();
    ok('the next verify starts at the anchor and checks only the new rows', inc.ok && inc.mode === 'from-anchor' && inc.checked === 1 && inc.rows === rows().length, inc);
    const txt = fs.readFileSync(LEDGER(), 'utf8').replace('"amount":100,', '"amount":10,'); fs.writeFileSync(LEDGER(), txt);
    ok('an edited row before the anchor: the anchored row moved, so the anchored verify fails too', !chain().ok, chain());
    ok('an edited row breaks the chain (verify --full)', !chain({ full: true }).ok && /hash does not match/.test(chain({ full: true }).problems.join(';')));
  });
}

if (require.main === module) {
  const a = S.args(); const cmd = a._[0] || (a.selftest ? 'selftest' : '');
  try {
    if (cmd === 'selftest') selftest();
    else if (cmd === 'invoice') S.out(0, invoice(a));
    else if (cmd === 'send') S.out(0, send(a));
    else if (cmd === 'receipt') S.out(0, receipt(a));
    else if (cmd === 'credit') S.out(0, credit(a));
    else if (cmd === 'payout') S.out(0, payout(a));
    else if (cmd === 'reconcile') { const r = reconcile(a); S.out(r.ok ? 0 : 1, r); }
    else if (cmd === 'summary') { const r = summary(); if (a.json) S.out(0, r); console.log('revenue ' + (r.totals.revenue || 0) + ' ' + (r.currency || '(no currency set)') + ', received ' + (r.totals.received || 0) + ', outstanding ' + (r.totals.outstanding || 0) + ', payouts ' + (r.totals.payouts || 0) + '; chain ' + (r.chain ? 'ok' : 'BROKEN')); }
    else if (cmd === 'check' || cmd === 'verify') { const r = chain({ full: !!a.full }); S.out(r.ok ? 0 : 1, r); }
    else S.out(2, { ok: false, error: 'commands: invoice, send, receipt, credit, payout, reconcile, summary, verify [--full], check, --selftest' });
  } catch (e) { S.out(1, { ok: false, error: e.message }); }
}
module.exports = { invoice, send, receipt, credit, payout, reconcile, summary, chain, invoices };
