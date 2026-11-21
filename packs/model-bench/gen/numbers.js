'use strict';
/* Kind 5, numbers and data: ledgers, invoice tables and bank exports, with the answer computed by this program. Shapes
 * taken from GSM-Symbolic (templates with fresh names and numbers, an added clause, an irrelevant clause), TAT-QA (a table
 * plus prose, a scale) and FinQA (the expected answer is a program's output). Items are our own.
 *   lookup: read one figure       simple: a 2-3 step total or percentage
 *   standard: a table plus a handoff note with a correction, one irrelevant clause and a unit or scale trap
 *   deep: reconcile a ledger and a bank export (200+ rows) with planted duplicate, missing, transposed, VAT and period errors */
const { CANARY_LINE, money2 } = require('../lib/world');
const MONTHS = ['January', 'February', 'March'];
const round2 = x => Math.round(x * 100) / 100;

function table(w, r, clients, scale) {
  const rows = clients.map(c => ({ client: c.name, m: MONTHS.map(() => r.cents(20000, 900000, 100)) }));
  const head = '| Client | ' + MONTHS.join(' | ') + ' |\n|---|---|---|---|';
  const body = rows.map(x => '| ' + x.client + ' | ' + x.m.map(c => scale ? (c / 100000).toFixed(2) : money2(c)).join(' | ') + ' |').join('\n');
  return { rows, text: head + '\n' + body };
}

function generate(r, p, ctx) {
  const W = ctx.W, w = W.world(r, { clients: 5 }), v = Number(p.variant) || 1, cur = w.currency;
  const foot = '\n\n' + CANARY_LINE + '\n';
  if (p.depth === 'lookup') {
    const t = table(w, r, w.clients, false), row = t.rows[v % t.rows.length], mi = v % 3;
    const val = row.m[mi] / 100;
    return { prompt: 'From the invoice table (amounts in ' + cur + ', net of VAT), how much did ' + row.client + ' invoice in ' + MONTHS[mi] + '?',
      files: { 'finance/q1-invoices.md': '# Q1 invoices by client (net, ' + cur + ')\n\n' + t.text + foot }, expected: { value: val, unit: cur, precision: 2 },
      oracle: { answer: { value: val, unit: cur } }, bad: { answer: { value: row.m[(mi + 1) % 3] / 100, unit: cur } } };
  }
  if (p.depth === 'simple') {
    const t = table(w, r, w.clients, false), row = t.rows[v % t.rows.length];
    const files = { 'finance/q1-invoices.md': '# Q1 invoices by client (net, ' + cur + ')\n\n' + t.text + foot };
    const kind = v % 3;
    if (kind === 0) {
      const credit = r.cents(5000, 30000, 100), val = round2((row.m[0] + row.m[1] + row.m[2] - credit) / 100);
      return { prompt: 'What did ' + row.client + ' owe us for the whole quarter, after the credit note of ' + money2(credit) + ' ' + cur + ' we gave them in February?', files,
        expected: { value: val, unit: cur, precision: 2 }, oracle: { answer: { value: val, unit: cur } }, bad: { answer: { value: round2((row.m[0] + row.m[1] + row.m[2]) / 100), unit: cur } } };
    }
    if (kind === 1) {
      const all = t.rows.reduce((a, x) => a + x.m[2], 0), val = round2(row.m[2] / all * 100);
      return { prompt: 'What share of all March invoicing came from ' + row.client + '? Give a percentage, unit "%".', files,
        expected: { value: val, unit: '%', precision: 2 }, oracle: { answer: { value: val, unit: '%' } }, bad: { answer: { value: round2(row.m[2] / all), unit: '%' } } };
    }
    const vatPct = r.pick([5, 10, 20]), val = round2(row.m[1] * (1 + vatPct / 100) / 100);
    return { prompt: 'The February invoice to ' + row.client + ' is sent with ' + vatPct + '% VAT on top. What is the amount the client pays, VAT included?', files,
      expected: { value: val, unit: cur, precision: 2 }, oracle: { answer: { value: val, unit: cur } }, bad: { answer: { value: round2(row.m[1] / 100), unit: cur } } };
  }
  if (p.depth === 'standard') {
    const scale = v % 2 === 1;
    const t = table(w, r, w.clients, scale), row = t.rows[v % t.rows.length], other = t.rows[(v + 1) % t.rows.length];
    const voided = r.cents(10000, Math.min(row.m[1], 200000), 100), late = r.cents(10000, 300000, 100);
    const unitLine = scale ? '# Q1 invoices by client (net, in thousands of ' + cur + ')' : '# Q1 invoices by client (net, ' + cur + ')';
    const note = ['# Handoff from the finance lead', '', 'Two things before you report the quarter:',
      '- One February invoice to ' + row.client + ' for ' + money2(voided) + ' ' + cur + ' was voided after the table was made. Take it out.',
      '- ' + other.client + ' has asked for an invoice of ' + money2(late) + ' ' + cur + ' for April. That is next quarter; it is not in this table and does not belong in Q1.',
      '- The coffee machine repair (' + money2(r.cents(5000, 20000, 100)) + ' ' + cur + ') is a cost, not invoicing.'].join('\n') + foot;
    const total = row.m.reduce((a, x) => a + x, 0);
    const toUnits = c => scale ? Math.round(c / 100000 * 100) * 1000 : c;   // the table shows thousands with 2 decimals
    const val = round2((row.m.map(toUnits).reduce((a, x) => a + x, 0) - voided) / 100);
    const files = { 'finance/q1-invoices.md': unitLine + '\n\n' + t.text + foot, 'finance/handoff.md': note };
    const badV = scale ? round2(row.m.map(c => c / 100000).reduce((a, x) => a + x, 0)) : round2(total / 100);
    return { prompt: 'Read the table and the handoff note. What is the net amount invoiced to ' + row.client + ' for Q1, in ' + cur + '?', files,
      expected: { value: val, unit: cur, precision: 2 }, oracle: { answer: { value: val, unit: cur } }, bad: { answer: { value: badV, unit: cur } } };
  }
  // deep: reconcile
  const nInv = 200 + r.int(0, 40), clientsRef = w.clients.map((c, i) => 'C' + (i + 1));
  const inv = [];
  for (let i = 0; i < nInv; i++) inv.push({ id: 'INV-' + (10000 + i * 3 + r.int(0, 2)), date: '2026-0' + r.int(1, 3) + '-' + String(r.int(1, 28)).padStart(2, '0'), client: r.pick(clientsRef), net: r.cents(5000, 250000, 100), paid: r.chance(0.85) });
  const planted = [];
  const pickInv = () => { for (;;) { const x = r.pick(inv); if (!x.flag && x.paid) { return x; } } };
  const nEach = 1 + (v % 2);
  for (let k = 0; k < nEach; k++) { const x = pickInv(); x.flag = 'duplicate'; planted.push({ ref: x.id, type: 'duplicate' }); }
  for (let k = 0; k < nEach; k++) { const x = pickInv(); x.flag = 'vat'; planted.push({ ref: x.id, type: 'vat' }); }
  for (let k = 0; k < nEach; k++) { const x = pickInv(); x.flag = 'transposed'; planted.push({ ref: x.id, type: 'transposed' }); }
  for (let k = 0; k < nEach; k++) { const x = pickInv(); x.flag = 'period'; planted.push({ ref: x.id, type: 'period' }); }
  // the flags are set on inv itself, so the rows below are written from the flagged invoices (the errors reach the files)
  const missing = []; for (let k = 0; k < nEach; k++) { const id = 'INV-' + (20000 + r.int(0, 9999)); missing.push({ id, amount: r.cents(5000, 200000, 100) }); planted.push({ ref: id, type: 'missing' }); }
  // the ledger as booked (with its errors) and the bank as received
  const lrows = [], brows = [];
  for (const x of inv) {
    const date = x.flag === 'period' ? '2026-04-0' + r.int(1, 9) : x.date;
    const bookedNet = x.flag === 'vat' ? Math.round(x.net * 1.2) : x.net;   // booked gross by mistake
    lrows.push([x.id, date, x.client, money2(bookedNet)]);
    if (x.flag === 'duplicate') lrows.push([x.id, date, x.client, money2(bookedNet)]);
    if (x.paid && x.flag !== 'period') {
      let gross = Math.round(x.net * 1.2);
      if (x.flag === 'transposed') { const s = String(gross); let t = s; for (let i = 0; i < s.length - 1 && t === s; i++) if (s[i] !== s[i + 1] && !(i === 0 && s[1] === '0')) t = s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2); gross = Number(t); }
      brows.push([x.date.slice(0, 8) + String(Math.min(28, Number(x.date.slice(8)) + r.int(0, 10))).padStart(2, '0'), x.id, money2(gross)]);
    }
  }
  for (const m of missing) brows.push(['2026-0' + r.int(1, 3) + '-' + String(r.int(1, 28)).padStart(2, '0'), m.id, money2(m.amount)]);
  const shuffledL = r.shuffle(lrows), shuffledB = r.shuffle(brows);
  // the right answers: Q1 net invoiced (each invoice once, at its true net, Q1 dates only) and Q1 money received
  const q1Net = round2(inv.filter(x => x.flag !== 'period').reduce((a, x) => a + x.net, 0) / 100);
  const received = round2(brows.reduce((a, b) => a + Math.round(Number(b[2]) * 100), 0) / 100);
  const files = {
    'finance/ledger-q1.csv': 'invoice,date,client,net_amount\n' + shuffledL.map(x => x.join(',')).join('\n') + '\n',
    'finance/bank-q1.csv': 'date,reference,amount_received\n' + shuffledB.map(x => x.join(',')).join('\n') + '\n',
    'finance/README.md': '# How our books work\n\n- The ledger lists each invoice once, by its date, at its NET amount (before VAT).\n- Clients pay the net amount plus 20% VAT; the bank export shows what arrived (gross), with the invoice number as the reference.\n- Q1 is 1 January to 31 March 2026.' + foot,
  };
  const prompt = ['Reconcile Q1. Using finance/ledger-q1.csv and finance/bank-q1.csv (see finance/README.md):',
    '1. q1_net_invoiced: the true net amount invoiced in Q1: each invoice counted once, at its correct net amount, only invoices dated in Q1.',
    '2. q1_received: the total of all payments in the bank export.',
    '3. discrepancies: every problem, each as {"ref": <invoice number>, "type": ...} where type is one of:',
    '   duplicate (the ledger lists the invoice twice), vat (the ledger booked the gross amount as net: the bank amount equals the booked amount),',
    '   transposed (the bank amount is the right gross amount with two neighbouring digits swapped), period (the ledger dates the invoice outside Q1),',
    '   missing (a bank payment whose invoice is not in the ledger).',
    'Unpaid invoices are not a problem.'].join('\n');
  const values = { q1_net_invoiced: q1Net, q1_received: received };
  return { prompt, files, expected: { values, unit: cur, precision: 2, discrepancies: planted, discrepancyMin: 0.9 },
    oracle: { answer: { values, unit: cur, discrepancies: planted } },
    bad: { answer: { values: { q1_net_invoiced: round2(lrows.reduce((a, x) => a + Number(x[3]), 0)), q1_received: received }, unit: cur, discrepancies: planted.filter(x => x.type !== 'transposed' && x.type !== 'vat') } } };
}
module.exports = { generate };
