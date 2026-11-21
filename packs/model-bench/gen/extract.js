'use strict';
/* Kind 2, summarize and extract: fictional invoices, client agreements, handoffs and an amendment. Shapes taken from
 * Kleister (fixed keys, normalised values, keys the document leaves empty), CORD (invoice fields), CUAD (a menu of
 * clauses) and ContractNLI (yes / no / not stated, with the evidence line). Items are our own.
 *   lookup: 3 invoice fields      simple: 5-6 agreement fields
 *   standard: about 10 fields, some absent, an empty decoy key, plus the 3 deliverables
 *   deep: yes / no / not_stated with a quoted line, across an agreement and its amendment (the later document wins) */
const { CANARY_LINE, day, money, money2 } = require('../lib/world');
const iso2long = d => { const [y, m, dd] = d.split('-').map(Number); return dd + ' ' + ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1] + ' ' + y; };
const DELIV = ['a monthly sales summary', 'two design revisions per month', 'a stock count each quarter', 'a newsletter draft every fortnight',
  'an updated price list each season', 'a delivery rota every Friday', 'a booking page check every Monday', 'a yearly accounts pack'];

function generate(r, p, ctx) {
  const W = ctx.W, w = W.world(r, { clients: 2 }), v = Number(p.variant) || 1;
  const client = w.clients[0], cur = w.currency;
  const foot = '\n\n' + CANARY_LINE + '\n';
  if (p.depth === 'lookup') {
    const no = 'INV-' + r.int(2400, 9800), lines = [];
    let sub = 0; for (let i = 0; i < 3 + (v % 3); i++) { const q = r.int(1, 6), u = r.cents(1500, 18000, 50); sub += q * u; lines.push([r.pick(['Design hours', 'Delivery', 'Print run', 'Support hours', 'Materials']), q, money2(u), money2(q * u)]); }
    const vat = Math.round(sub * 0.2), total = sub + vat, prev = r.cents(1000, 50000, 100), due = day(r.int(10, 60)), issued = day(r.int(-5, 5));
    const layout = v % 3;
    const head = layout === 0 ? '# INVOICE ' + no : layout === 1 ? 'Invoice no. ' + no + ' from ' + w.company : w.company + ', invoice reference ' + no;
    const dueLine = layout === 2 ? 'Please pay by ' + iso2long(due) + '.' : 'Due date: ' + due;
    const doc = [head, '', 'Billed to: ' + client.name, 'Issued: ' + issued, dueLine, '', '| Item | Qty | Unit | Line |', '|---|---|---|---|']
      .concat(lines.map(l => '| ' + l.join(' | ') + ' |'))
      .concat(['', 'Subtotal: ' + money(sub) + ' ' + cur, 'VAT (20%): ' + money(vat) + ' ' + cur, 'Total due: ' + money(total) + ' ' + cur, '', 'Balance from your previous statement (paid, thank you): ' + money(prev) + ' ' + cur]).join('\n') + foot;
    const fields = { invoice_number: no, total: money2(total), due_date: due };
    return pack('Extract the fields invoice_number, total and due_date from the invoice.', { 'invoice.md': doc }, { fields, types: { total: 'money', due_date: 'date' }, threshold: 1 },
      { invoice_number: no, total: money2(sub), due_date: due });
  }
  if (p.depth === 'simple') {
    const start = day(r.int(-30, 40)), fee = r.cents(30000, 400000, 500), notice = r.pick([30, 45, 60, 90]), terms = r.pick([14, 21, 30]), months = r.pick([6, 12, 18, 24]);
    const keys = ['client_name', 'start_date', 'monthly_fee', 'notice_days', 'payment_terms_days', 'term_months'].slice(0, 5 + (v % 2));
    const doc = ['# Service agreement', '', 'Between ' + w.company + ' ("we") and ' + client.name + ' ("the client").', '',
      '1. Start. The services start on ' + iso2long(start) + ' and run for ' + months + ' months.',
      '2. Fee. The client pays ' + money(fee) + ' ' + cur + ' a month, invoiced on the first working day.',
      '3. Payment. Invoices are due within ' + terms + ' days.',
      '4. Ending. Either side may end this agreement with ' + notice + ' days\' written notice.',
      '5. Contact. Day-to-day contact for the client is ' + client.contact + '.'].join('\n') + foot;
    const all = { client_name: client.name, start_date: start, monthly_fee: money2(fee), notice_days: String(notice), payment_terms_days: String(terms), term_months: String(months) };
    const fields = Object.fromEntries(keys.map(k => [k, all[k]]));
    const bad = Object.assign({}, fields, { notice_days: String(notice === terms ? notice + 15 : terms) });   // the payment terms read as the notice period
    return pack('Extract these fields from the agreement: ' + keys.join(', ') + '.', { 'agreement.md': doc }, { fields, types: { start_date: 'date', monthly_fee: 'money', notice_days: 'int', payment_terms_days: 'int', term_months: 'int' }, threshold: 1 }, bad);
  }
  if (p.depth === 'standard') {
    const start = day(r.int(-30, 40)), fee = r.cents(30000, 400000, 500), notice = r.pick([30, 45, 60, 90]);
    const hasEnd = v % 2 === 0, hasLate = v % 3 !== 0;
    const end = day(r.int(200, 400)), late = r.pick([1.5, 2, 3]), review = r.pick(['March', 'June', 'September', 'December']);
    const email = client.contact.split(' ')[0].toLowerCase() + '@' + client.name.toLowerCase().replace(/[^a-z]+/g, '') + '.example';
    const deliv = r.sample(DELIV, 3);
    const handoff = ['# Handoff: new client ' + client.name, '', '**From:** ' + w.seats[0].name + ' **To:** ' + w.seats[1].name, '',
      'Signed last week. Contact is ' + client.contact + ' (' + email + '). Everything else is in the agreement below; the PO number field is still blank because they have not sent one.',
      '', 'Things to watch: they pay late in summer. ' + w.seats[0].name + ' thinks the review month should move, but nothing is agreed.'].join('\n') + foot;
    const doc = ['# Agreement for ongoing services', '', 'Client: ' + client.name, 'Purchase order number: ', 'Currency: ' + cur, '',
      'Term. From ' + start + (hasEnd ? ' until ' + end + '.' : ', rolling month to month.'),
      'Fees. ' + money(fee) + ' ' + cur + ' per month.',
      'Notice. ' + notice + ' days in writing.',
      hasLate ? 'Late payment. Overdue invoices carry ' + late + '% interest a month.' : 'Late payment. We will remind the client in writing.',
      'Review. Prices are reviewed each ' + review + '.',
      'Deliverables. We provide: ' + deliv.join('; ') + '.'].join('\n') + foot;
    const fields = { client_name: client.name, contact_email: email, start_date: start, end_date: hasEnd ? end : null, monthly_fee: money2(fee), currency: cur,
      notice_days: String(notice), po_number: null, late_interest_pct: hasLate ? String(late) : null, review_month: review, deliverables: deliv };
    const bad = Object.assign({}, fields, { po_number: 'PO-' + r.int(1000, 9999), end_date: hasEnd ? end : day(365), late_interest_pct: hasLate ? String(late) : '2' });
    return pack('Read the handoff and the agreement. Extract: ' + Object.keys(fields).join(', ') + ' (deliverables is the list of the 3 things we provide, each as written).',
      { 'handoff.md': handoff, 'agreement.md': doc }, { fields, types: { start_date: 'date', end_date: 'date', monthly_fee: 'money', notice_days: 'int', late_interest_pct: 'number' }, threshold: 0.9 }, bad);
  }
  // deep: an agreement and its amendment; questions answered yes / no / not_stated with a quote
  const fee = r.cents(50000, 400000, 500), fee2 = fee + r.cents(5000, 40000, 500), notice = r.pick([30, 60]), notice2 = notice === 30 ? 60 : 90, cap = r.pick([2, 3, 4]);
  const sub = v % 2 === 0;
  const A = ['# Master services agreement', '', 'Parties: ' + w.company + ' and ' + client.name + '.', '',
    'Clause 1. The monthly fee is ' + money(fee) + ' ' + cur + '.',
    'Clause 2. Either party may end the agreement with ' + notice + ' days written notice.',
    'Clause 3. We may use subcontractors for printing work.',
    'Clause 4. The client owns the final designs once paid in full.',
    'Clause 5. Changes requested by the client are billed at the hourly rate.',
    'Clause 6. Rush jobs are limited to ' + cap + ' per month.'].join('\n') + foot;
  const B = ['# Amendment 1 to the master services agreement', '', 'Dated ' + day(90) + '. This amendment replaces the clauses named below; all other clauses stay as they are.', '',
    'Clause 1 now reads: The monthly fee is ' + money(fee2) + ' ' + cur + '.',
    'Clause 2 now reads: Either party may end the agreement with ' + notice2 + ' days written notice.',
    sub ? 'Clause 3 now reads: We may not use subcontractors without the client\'s written consent.' : 'Clause 6 now reads: Rush jobs are limited to ' + (cap + 2) + ' per month.'].join('\n') + foot;
  const qs = [
    { id: 'c1', q: 'Can the client end the agreement with ' + notice + ' days notice?', label: 'no', quote: 'Clause 2 now reads: Either party may end the agreement with ' + notice2 + ' days written notice.' },
    { id: 'c2', q: 'May we use subcontractors for printing work without asking the client?', label: sub ? 'no' : 'yes', quote: sub ? 'Clause 3 now reads: We may not use subcontractors without the client\'s written consent.' : 'Clause 3. We may use subcontractors for printing work.' },
    { id: 'c3', q: 'Does the client own the final designs once they have paid in full?', label: 'yes', quote: 'Clause 4. The client owns the final designs once paid in full.' },
    { id: 'c4', q: 'Does the agreement set a cap on our total liability?', label: 'not_stated', quote: '' },
    { id: 'c5', q: 'Are rush jobs limited to ' + cap + ' per month?', label: sub ? 'yes' : 'no', quote: sub ? 'Clause 6. Rush jobs are limited to ' + cap + ' per month.' : 'Clause 6 now reads: Rush jobs are limited to ' + (cap + 2) + ' per month.' },
    { id: 'c6', q: 'Is there a fixed end date for the agreement?', label: 'not_stated', quote: '' },
  ].slice(0, 4 + (v % 3));
  const fields = { monthly_fee: money2(fee2), notice_days: String(notice2) };
  const exp = { fields, types: { monthly_fee: 'money', notice_days: 'int' }, threshold: 0.9, questions: qs.map(q => ({ id: q.id, label: q.label })), sourceText: A + '\n' + B };
  const prompt = 'Read the agreement and its amendment. Extract the fields monthly_fee and notice_days as they stand now. Then answer each question with yes, no or not_stated, quoting the line that decides it (no quote for not_stated):\n' + qs.map(q => q.id + ': ' + q.q).join('\n');
  const oracle = { fields, answers: qs.map(q => ({ id: q.id, label: q.label, quote: q.quote })) };
  // known-bad: reads the original agreement and ignores the amendment
  const badA = { fields: { monthly_fee: money2(fee), notice_days: String(notice) }, answers: qs.map(q => q.id === 'c1' ? { id: 'c1', label: 'yes', quote: 'Clause 2. Either party may end the agreement with ' + notice + ' days written notice.' } : { id: q.id, label: q.label, quote: q.quote }) };
  return { prompt, files: { 'agreement.md': A, 'amendment-1.md': B }, expected: exp, oracle: { answer: oracle }, bad: { answer: badA } };
}
function pack(prompt, files, expected, badFields) {
  expected.sourceText = Object.values(files).join('\n');
  return { prompt, files, expected, oracle: { answer: { fields: expected.fields } }, bad: { answer: { fields: badFields } } };
}
module.exports = { generate };
