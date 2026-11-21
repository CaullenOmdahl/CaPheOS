'use strict';
/* Kind 1, lookup: a generated company workspace (client files, handoffs, ledger, inbox notes, project sheets) and questions
 * whose answers sit in it. Shapes taken from RULER (needles among distractors, multi-hop tracking, aggregation), MuSiQue
 * (hops composed from single facts, unanswerable items) and FRAMES (question categories). Items are our own.
 *   lookup:   1 file, 1 fact          simple:  3-5 files plus distractor clients, 1-2 facts
 *   standard: 20+ files, 3 items, 2 of them two hops, the file path needed
 *   deep:     6 items: 3-4 hops, near-duplicate client names, a value superseded by a later note, 2 not in the files */
const { CANARY_LINE, NEAR, day, money2 } = require('../lib/world');

const TOWNS = ['Ambleford', 'Kelmscott Vale', 'Dunmere', 'Harrowgate Cross', 'Lowestry', 'Pellham', 'Sunderby', 'Wyckhollow'];
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const slug = s => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function clientFacts(r, w, c, i) {
  return {
    name: c.name, contact: c.contact, town: r.pick(TOWNS),
    rate: r.int(38, 140) + (r.chance(0.5) ? 0.5 : 0), currency: w.currency,
    renewal: day(r.int(20, 300)), noticeDays: r.pick([14, 30, 45, 60, 90]), deliveryDay: r.pick(DAYS),
    ref: 'CL-' + (1100 + i * 7 + r.int(0, 6)), lead: r.pick(w.seats).name, project: r.pick(['Spring catalogue', 'Booking page refresh', 'Stock count tool', 'Quarterly accounts', 'Price list update', 'Customer survey', 'Delivery rota', 'Loyalty cards']) + ' ' + (i + 1),
  };
}
const FACT = {
  // every question asks in the files' own terms ("we bill", "notice period", "deliveries go out"), and its also list
  // holds the forms copied word for word from the files ("30 days", "Tuesdays"); scorers/exact.js also drops unit tails
  rate: { q: c => 'What hourly rate do we bill ' + c.name + '?', v: c => String(c.rate) + ' ' + c.currency, also: c => [String(c.rate), money2(Math.round(c.rate * 100)) + ' ' + c.currency] },
  renewal: { q: c => 'On what date does the agreement with ' + c.name + ' renew?', v: c => c.renewal },
  notice: { q: c => 'What is the notice period for ' + c.name + ', in days?', v: c => String(c.noticeDays), also: c => [c.noticeDays + ' days'] },
  contact: { q: c => 'Who is the main contact at ' + c.name + '?', v: c => c.contact },
  delivery: { q: c => 'On which weekday do deliveries go out to ' + c.name + '?', v: c => c.deliveryDay, also: c => [c.deliveryDay + 's'] },
  town: { q: c => 'In which town is ' + c.name + ' based?', v: c => c.town },
  ref: { q: c => 'What is the client reference for ' + c.name + '?', v: c => c.ref },
};
const FACT_KEYS = Object.keys(FACT);

function clientFile(c, o) {
  o = o || {};
  const lines = ['# Client: ' + c.name, '', '- Reference: ' + c.ref, '- Main contact: ' + c.contact, '- Based in: ' + c.town,
    '- Hourly rate: ' + c.rate + ' ' + c.currency, '- Agreement renews: ' + c.renewal];
  if (!o.noNotice) lines.push('- Notice period: ' + c.noticeDays + ' days');
  lines.push('- Deliveries: ' + c.deliveryDay + 's', '', 'Notes: keep invoices to one page; send statements at month end.', '', '<!-- ' + CANARY_LINE + ' -->', '');
  return lines.join('\n');
}
function handoffFile(seat, items) {
  return ['# Handoff: ' + seat.name + ' (' + seat.title + ')', ''].concat(items.flatMap((it, k) => ['## Item ' + (k + 1) + ': ' + it.title, '**Status:** ' + it.status, it.body, ''])).concat(['<!-- ' + CANARY_LINE + ' -->', '']).join('\n');
}
function projectFile(c) {
  return ['# Project: ' + c.project, '', '- Client: ' + c.name, '- Lead: ' + c.lead, '- Started: ' + day(-40 + (c.ref.charCodeAt(5) % 30)), '', '<!-- ' + CANARY_LINE + ' -->', ''].join('\n');
}

function generate(r, p, ctx) {
  const W = ctx.W;
  const v = Number(p.variant) || 1;
  if (p.depth === 'lookup') {
    const w = W.world(r, { clients: 1 }); const c = clientFacts(r, w, w.clients[0], 0); const seat = w.seats[0];
    const key = FACT_KEYS[(v - 1) % FACT_KEYS.length];
    const body = ['Client ' + c.name + ' (ref ' + c.ref + ') is with us since last spring.', 'Their main contact is ' + c.contact + '.', c.name + ' is based in ' + c.town + '.',
      'We bill ' + c.rate + ' ' + c.currency + ' an hour; the agreement renews on ' + c.renewal + '.', 'Notice period is ' + c.noticeDays + ' days. Deliveries go out on ' + c.deliveryDay + 's.'].join('\n');
    const f = 'handoffs/' + slug(seat.name) + '.md';
    const files = { [f]: handoffFile(seat, [{ title: 'Taking over ' + c.name, status: 'OPEN', body }]) };
    const it = { id: 'q1', value: FACT[key].v(c), also: FACT[key].also ? FACT[key].also(c) : [], q: FACT[key].q(c), about: c.name };
    return out('Question q1: ' + it.q, files, [it], false);
  }
  if (p.depth === 'simple') {
    const n = 3 + (v % 3);   // 3 to 5 files
    const w = W.world(r, { clients: n }); const cs = w.clients.map((c, i) => clientFacts(r, w, c, i));
    const files = {}; cs.forEach(c => { files['clients/' + slug(c.name) + '.md'] = clientFile(c); });
    const qs = v % 2 === 0 ? 2 : 1;
    const items = [], lines = [];
    for (let k = 0; k < qs; k++) { const c = cs[(v + k) % cs.length], key = FACT_KEYS[(v + k * 3) % FACT_KEYS.length]; items.push({ id: 'q' + (k + 1), value: FACT[key].v(c), also: FACT[key].also ? FACT[key].also(c) : [], q: FACT[key].q(c), about: c.name }); lines.push('Question q' + (k + 1) + ': ' + FACT[key].q(c)); }
    return out(lines.join('\n'), files, items, false);
  }
  // standard and deep: a whole workspace
  const deep = p.depth === 'deep';
  const w = W.world(r, { clients: deep ? 6 : 5, seats: 6 }); const cs = w.clients.map((c, i) => clientFacts(r, w, c, i));
  cs.forEach((c, i) => { c.lead = w.seats[i % w.seats.length].name; });   // one project per lead, so every hop has one answer
  const files = {};
  const noNotice = deep ? cs[(v + 2) % cs.length] : null;
  for (const c of cs) { files['clients/' + slug(c.name) + '.md'] = clientFile(c, { noNotice: c === noNotice }); files['projects/' + slug(c.project) + '.md'] = projectFile(c); }
  // a near-duplicate client with other values (deep)
  let twin = null;
  if (deep) {
    const base = cs.find(c => NEAR[c.name]) || cs[0];
    twin = clientFacts(r, w, { name: NEAR[base.name] || base.name + ' Group', contact: w.person() }, 9);
    files['clients/' + slug(twin.name) + '.md'] = clientFile(twin);
    twin.of = base;
  }
  for (const s of w.seats) {
    const mine = cs.filter(c => c.lead === s.name);
    const items = mine.map(c => ({ title: c.project + ' for ' + c.name, status: r.pick(['OPEN', 'IN PROGRESS', 'WAITING']), body: 'Next: confirm the scope with ' + c.contact + '. Budget agreed by the owner.' }));
    items.push({ title: 'Weekly tidy-up', status: 'DONE', body: 'Filed the receipts and closed old notes.' });
    files['handoffs/' + slug(s.name) + '.md'] = handoffFile(s, items);
  }
  const rows = ['date,client_ref,description,amount,currency'];
  for (let i = 0; i < 24; i++) { const c = r.pick(cs); rows.push(day(r.int(-60, -1)) + ',' + c.ref + ',' + r.pick(['Design hours', 'Print run', 'Support', 'Delivery']) + ',' + money2(r.cents(4000, 90000, 50)) + ',' + w.currency); }
  files['ledger/2026-q1.csv'] = rows.join('\n') + '\n';
  for (let i = 0; i < 9; i++) files['inbox/note-' + String(i + 1).padStart(2, '0') + '.md'] = '# Note ' + (i + 1) + ' (' + day(-30 + i * 3) + ')\n\n' + r.pick(['Printer toner ordered.', 'Remember the fire drill on Thursday.', 'The van is booked for the 3rd.', 'Holiday rota is pinned in the kitchen.', 'New coffee supplier from next week.']) + '\n\n<!-- ' + CANARY_LINE + ' -->\n';
  const path = c => 'clients/' + slug(c.name) + '.md';
  const items = [], lines = [];
  const add = (q, it) => { it.id = 'q' + (items.length + 1); it.q = q; items.push(it); lines.push('Question ' + it.id + ': ' + q); };
  const pick = k => cs[(v + k) % cs.length];
  if (!deep) {
    const a = pick(0), keyA = FACT_KEYS[v % FACT_KEYS.length];
    add(FACT[keyA].q(a) + ' (give the path of the client file)', { value: FACT[keyA].v(a), also: FACT[keyA].also ? FACT[keyA].also(a) : [], path: path(a), about: a.name });
    const b = pick(1), keyB = FACT_KEYS[(v + 2) % FACT_KEYS.length];
    add(FACT[keyB].q({ name: 'the client of the project "' + b.project + '"' }) + ' (give the path of the client file)', { value: FACT[keyB].v(b), also: FACT[keyB].also ? FACT[keyB].also(b) : [], path: path(b), about: b.name });
    const c = cs.find(x => w.seats.some(s => s.name === x.lead) && cs.filter(y => y.lead === x.lead).length === 1) || pick(2);
    add('Who is the main contact at the client whose project is led by ' + c.lead + '? Give the path of the client file.', { value: c.contact, path: path(c), about: c.name });
    return out(lines.join('\n'), files, items, true, { tools: true });
  }
  // deep
  const a = pick(0);
  // a superseded rate: a later inbox note changes it
  const newRate = a.rate + r.int(4, 15);
  // the note takes a slot inside the run of inbox notes (its old occupant moves to note-10), so its number gives nothing
  // away; only its date and its words show it is the later word
  const slot = r.int(1, 9), nn = n => 'inbox/note-' + String(n).padStart(2, '0') + '.md', ratePath = nn(slot);
  files[nn(10)] = files[ratePath].replace(/^# Note \d+/, '# Note 10');
  // dated after every other note and already in force today (day 0), which the prompt states
  files[ratePath] = '# Note ' + slot + ' (' + day(-3) + ')\n\nRate change agreed with ' + a.contact + '. From ' + day(-2) + ' we bill ' + a.name + ' ' + newRate + ' ' + a.currency + ' an hour. The client file still shows the old rate until the finance lead updates it.\n\n<!-- ' + CANARY_LINE + ' -->\n';
  lines.push('Today is ' + day(0) + '.');
  add('What hourly rate do we bill ' + a.name + ' as of today? Give the path of the file that settles it.', { value: newRate + ' ' + a.currency, also: [String(newRate), money2(newRate * 100) + ' ' + a.currency], path: ratePath, about: a.name });
  const b = pick(1);
  add('In which town is the client of the project "' + b.project + '" based? Give the path of the client file.', { value: b.town, path: path(b), about: b.name });
  // three hops: seat -> project -> client -> its renewal date
  const c3 = cs.find(x => cs.filter(y => y.lead === x.lead).length === 1 && x !== a && x !== b) || pick(2);
  add('Find the handoff of ' + c3.lead + ', take the client of the project they lead, and give the date that client\'s agreement renews, with the path of the client file.', { value: c3.renewal, path: path(c3), about: c3.name });
  add('What is the client reference for ' + twin.name + '? Give the path of the file.', { value: twin.ref, path: path(twin), about: twin.name });
  add(FACT.notice.q(noNotice), { notFound: true });
  add(FACT.rate.q({ name: W.COMPANIES.find(x => !cs.some(c => c.name === x) && x !== twin.name) || 'Lindenfield Ltd' }), { notFound: true });
  return out(lines.join('\n'), files, items, true, { tools: true });
}
function out(q, files, items, needPath) {
  const answers = items.map(it => it.notFound ? { id: it.id, value: 'not_found' } : Object.assign({ id: it.id, value: it.value }, needPath ? { path: it.path } : {}));
  // known-bad: the first item wrong (a near miss), the rest right
  const bad = answers.map((x, i) => i === 0 ? Object.assign({}, x, { value: x.value === 'not_found' ? 'unknown' : String(x.value) + 'x' }) : x);
  return { prompt: q, files, expected: { items, needPath }, oracle: { answer: { answers } }, bad: { answer: { answers: bad } } };
}
module.exports = { generate };
