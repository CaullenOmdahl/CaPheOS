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
 *   node ledger.js check                                  verify the hash chain; exit 1 if broken
 *   node ledger.js --selftest
 * Owner of this tool: the finance function. Amounts are numbers in the one currency the owner sets (limits currency).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const S = require((() => { let d = __dirname; for (let i = 0; i < 6; i++, d = path.dirname(d)) { const f = path.join(d, 'company', 'tools', 'lib', 'settle.js'); if (fs.existsSync(f)) return f; } return path.join(__dirname, 'lib', 'settle.js'); })());
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
function append(row) {
  const all = rows(); const last = all[all.length - 1];
  const r = Object.assign({ seq: all.length + 1, at: new Date().toISOString() }, row, { prev: last ? last.hash : null });
  r.hash = hashOf(r);
  S.appendJsonl(LEDGER(), r);
  return r;
}
function chain() {
  const all = rows(); const problems = []; let prev = null;
  all.forEach((r, i) => {
    if (r.seq !== i + 1) problems.push('row ' + (i + 1) + ': seq ' + r.seq);
    if ((r.prev || null) !== prev) problems.push('row ' + (i + 1) + ': prev does not match the row before');
    if (hashOf(r) !== r.hash) problems.push('row ' + (i + 1) + ': hash does not match its content');
    prev = r.hash;
  });
  return { ok: !problems.length, rows: all.length, problems };
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
  const g = S.gate().check({ category: 'message', target, agent: by, note: 'invoice ' + i.invoice + ' party:' + i.party + ' total ' + i.total + ' ' + i.currency }, GATE_OPTS || {});
  if (!g.allow) throw new Error('refused by the external gate: ' + g.reason);
  const r = append({ type: 'invoice-sent', invoice: i.invoice, party: i.party, target, by, clearanceId: g.clearanceId, clearedBy: g.clearedBy });
  S.appendJsonl(OUTBOX(), { at: r.at, invoice: i.invoice, party: i.party, target, total: i.total, currency: i.currency, lines: i.lines, ledgerSeq: r.seq });
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
  const g = S.gate().check({ category: 'spend', target: to, agent: by, note: 'payout ' + amount + (o.party ? ' party:' + o.party : '') + ': ' + reason }, GATE_OPTS || {});
  if (!g.allow) throw new Error('refused by the external gate: ' + g.reason);
  return append({ type: 'payout', party: o.party || null, to, amount, currency: S.limits('ledger').currency, reason, by, clearanceId: g.clearanceId });
}
function reconcile(o) {
  const by = need(o, 'by'); const party = o.party && o.party !== true ? String(o.party) : null;
  const inv = Object.values(invoices()).filter(i => !party || i.party === party);
  const mine = inv.filter(i => String(i.by).toLowerCase() === by.toLowerCase());
  if (mine.length) throw new Error('refused: ' + by + ' issued ' + mine.map(i => i.invoice).join(', ') + '; reconcile is done by a seat other than the one that invoiced');
  const c = chain(); const findings = c.problems.slice();
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
    const txt = fs.readFileSync(LEDGER(), 'utf8').replace('"amount":100,', '"amount":10,'); fs.writeFileSync(LEDGER(), txt);
    ok('an edited row breaks the chain', !chain().ok && /hash does not match/.test(chain().problems.join(';')));
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
    else if (cmd === 'check') { const r = chain(); S.out(r.ok ? 0 : 1, r); }
    else S.out(2, { ok: false, error: 'commands: invoice, send, receipt, credit, payout, reconcile, summary, check, --selftest' });
  } catch (e) { S.out(1, { ok: false, error: e.message }); }
}
module.exports = { invoice, send, receipt, credit, payout, reconcile, summary, chain, invoices };
