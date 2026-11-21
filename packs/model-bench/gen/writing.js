'use strict';
/* Kind 3, writing for a non-technical owner or a client. Shapes taken from IFEval and IFBench (instructions a program can
 * check, length ranges) and InFoBench (each requirement as a yes/no question; DRFR). Items are our own.
 *   lookup: a status line of at most 3 sentences with 2 points
 *   simple: a client reply with 3-4 points and a length limit
 *   standard: a messy handoff turned into a plain note with 5-6 points; 2 internal details must stay out
 *   deep: bad news, an owner decision and a refusal under a house rule, 8+ points, tone rules, a closing question */
const { CANARY_LINE, day, money } = require('../lib/world');
const T = require('../lib/text');
const when = n => { const d = new Date(Date.UTC(2026, 2, 2) + n * 864e5); return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][d.getUTCMonth()]; };

// each scenario: facts -> points [{say (plain sentence), q (judge question), ev (stub-judge evidence words)}]
const SCEN = [
  (r, w) => { const c = w.clients[0], n = r.int(2, 5), d = r.int(3, 9); return { topic: 'the late print order for ' + c.name, points: [
    { say: 'The print order for ' + c.name + ' is ' + n + ' days late.', q: 'Does the note say the order for ' + c.name + ' is ' + n + ' days late?', ev: [String(n), 'late'] },
    { say: 'It will now arrive on ' + when(d) + '.', q: 'Does the note give the new arrival day, ' + when(d) + '?', ev: [when(d).split(' ')[0]] },
    { say: 'The paper supplier ran short, and we have moved to a second supplier.', q: 'Does the note explain that the paper supplier ran short?', ev: ['supplier'] },
    { say: 'We have told ' + c.contact + ' and they are fine with the new day.', q: 'Does the note say the client contact was told and agreed?', ev: [c.contact.split(' ')[0]] },
    { say: 'There is no extra cost to us or to the client.', q: 'Does the note say there is no extra cost?', ev: ['no extra cost'] },
    { say: 'Next week we will order paper two weeks earlier.', q: 'Does the note say what we will do differently next time?', ev: ['earlier'] },
  ], internal: ['ticket PRN-' + r.int(1000, 9999), 'the retry job in jobs/print-queue.js'], ask: { words: ['discount', 'gesture'], say: 'Would you like us to offer ' + c.name + ' a small discount as a thank-you?', q: 'Does the note end by asking the owner whether to offer the client a discount?' } }; },
  (r, w) => { const pct = r.int(4, 9), m = when(r.int(20, 40)); return { topic: 'the supplier price rise', points: [
    { say: 'Our main supplier is raising prices by ' + pct + ' percent.', q: 'Does the note say prices go up by ' + pct + ' percent?', ev: [String(pct)] },
    { say: 'The new prices start on ' + m + '.', q: 'Does the note say when the new prices start?', ev: [m.split(' ')[1]] },
    { say: 'Three of our five regular jobs use this supplier.', q: 'Does the note say how many regular jobs are affected?', ev: ['three', '3'] },
    { say: 'We found a second supplier who is a little cheaper but slower.', q: 'Does the note mention the cheaper but slower second supplier?', ev: ['slower'] },
    { say: 'If we keep our own prices the same, we earn less on those jobs.', q: 'Does the note explain the effect on our earnings if prices stay the same?', ev: ['earn less'] },
    { say: 'Nothing changes for clients until you decide.', q: 'Does the note say nothing changes for clients until the owner decides?', ev: ['until you decide'] },
  ], internal: ['the cost sheet in finance/costs-2026.xlsx', 'vendor id V-' + r.int(100, 999)], ask: { words: ['raise', 'prices'], say: 'Should we raise our prices by the same amount, or keep them as they are?', q: 'Does the note end by asking the owner whether to raise our prices?' } }; },
  (r, w) => { const h = r.int(2, 5), c = r.int(3, 12); return { topic: 'the booking page being down', points: [
    { say: 'Our booking page was down for about ' + h + ' hours this morning.', q: 'Does the note say the booking page was down for about ' + h + ' hours?', ev: [String(h), 'hours'] },
    { say: 'It is working again now.', q: 'Does the note say it is working again?', ev: ['working again'] },
    { say: 'About ' + c + ' customers could not book during that time.', q: 'Does the note say about ' + c + ' customers could not book?', ev: [String(c)] },
    { say: 'We have called each of them to rebook.', q: 'Does the note say we contacted those customers to rebook?', ev: ['rebook'] },
    { say: 'The cause was a setting our web host changed without telling us.', q: 'Does the note give the cause in plain words?', ev: ['host'] },
    { say: 'We now get a warning within ten minutes if the page stops.', q: 'Does the note say we will now get an early warning?', ev: ['warning'] },
  ], internal: ['error 502 in the access log', 'the cron entry on server 2'], ask: { words: ['host', 'move'], say: 'Do you want us to look at moving to a different web host?', q: 'Does the note end by asking the owner whether to look at a different web host?' } }; },
  (r, w) => { const c = w.clients[1] || w.clients[0], amt = r.cents(40000, 300000, 500); return { topic: 'an invoice we forgot to send', points: [
    { say: 'We forgot to send ' + c.name + ' their invoice for last month.', q: 'Does the note say the invoice to ' + c.name + ' was not sent?', ev: [c.name.split(' ')[0]] },
    { say: 'The amount is ' + money(amt) + ' ' + w.currency + '.', q: 'Does the note give the amount, ' + money(amt) + '?', ev: [money(amt)] },
    { say: 'We sent it today with a short apology.', q: 'Does the note say it was sent today with an apology?', ev: ['today'] },
    { say: 'They have 30 days to pay, as usual.', q: 'Does the note say the usual 30 days to pay apply?', ev: ['30'] },
    { say: 'Our cash for this month is still fine.', q: 'Does the note say this month\'s cash is still fine?', ev: ['cash'] },
    { say: 'We now check every client\'s invoice on the last working day.', q: 'Does the note say how we will avoid it next time?', ev: ['last working day'] },
  ], internal: ['invoice run INVRUN-' + r.int(10, 99), 'the export in billing/out.csv'], ask: { words: ['reminder', 'call'], say: 'Should we also call them, or is the email enough?', q: 'Does the note end by asking the owner whether to call the client too?' } }; },
  (r, w) => { const s = w.seats[0], d1 = r.int(5, 15), len = r.int(5, 12); return { topic: 'holiday cover for ' + s.name, points: [
    { say: s.name + ' is on holiday from ' + when(d1) + ' for ' + len + ' days.', q: 'Does the note say when ' + s.name + '\'s holiday starts and how long it is?', ev: [String(len)] },
    { say: (w.seats[1] || s).name + ' will cover the client calls.', q: 'Does the note name who covers the client calls?', ev: [(w.seats[1] || s).name.split(' ')[0]] },
    { say: 'Two jobs may slip by a day or two.', q: 'Does the note say two jobs may slip a little?', ev: ['slip'] },
    { say: 'We have told the two clients already.', q: 'Does the note say the affected clients were told?', ev: ['told'] },
    { say: 'Invoices will still go out on time.', q: 'Does the note say invoices still go out on time?', ev: ['on time'] },
    { say: 'No overtime is needed.', q: 'Does the note say no overtime is needed?', ev: ['overtime'] },
  ], internal: ['the rota in ops/rota.md', 'access level 3 for the cover seat'], ask: { words: ['temporary', 'help'], say: 'Would you like us to bring in temporary help for that week?', q: 'Does the note end by asking the owner whether to bring in temporary help?' } }; },
  (r, w) => { const c = w.clients[0], fee = r.cents(80000, 300000, 500); return { topic: 'a new client starting', points: [
    { say: c.name + ' signed with us yesterday.', q: 'Does the note say ' + c.name + ' signed?', ev: [c.name.split(' ')[0]] },
    { say: 'They will pay ' + money(fee) + ' ' + w.currency + ' a month.', q: 'Does the note give the monthly fee?', ev: [money(fee)] },
    { say: 'Work starts next Monday.', q: 'Does the note say work starts next Monday?', ev: ['monday'] },
    { say: c.contact + ' is our contact there.', q: 'Does the note name the client contact?', ev: [c.contact.split(' ')[0]] },
    { say: 'The first month is a trial and either side can stop.', q: 'Does the note say the first month is a trial?', ev: ['trial'] },
    { say: 'We have room for the work without hiring.', q: 'Does the note say no hiring is needed?', ev: ['without hiring'] },
  ], internal: ['the lead id LEAD-' + r.int(100, 999), 'the scoring sheet in sales/leads.md'], ask: { words: ['welcome', 'call'], say: 'Would you like to join a short welcome call with them?', q: 'Does the note end by asking the owner whether to join a welcome call?' } }; },
];

/* The internal details a note must leave out, as the identifiers themselves (V-208, costs-2026.xlsx, jobs/print-queue.js,
 * print-queue.js, server 2), not only the whole phrase: a note that says "supplier V-208" leaks it as surely as one that
 * copies "vendor id V-208". The phrases stay in the list too. */
function leakTerms(phrases) {
  const out = [];
  for (const ph of phrases) {
    out.push(ph);
    for (const m of ph.matchAll(/[A-Za-z0-9_.-]*\/[A-Za-z0-9_./-]+|[A-Za-z0-9_-]+\.[a-z]{2,4}\b|\b[A-Z]+-\d+\b|\b(?:error|server|level) \d+\b/g)) {
      out.push(m[0]); if (m[0].includes('/')) out.push(m[0].split('/').pop());
    }
  }
  return [...new Set(out)];
}
function generate(r, p, ctx) {
  const W = ctx.W, w = W.world(r, { clients: 3, seats: 4 }), v = Number(p.variant) || 1;
  const sc = SCEN[(v - 1) % SCEN.length](r, w);
  const files = {};
  let prompt, pts, exp;
  if (p.depth === 'lookup') {
    pts = sc.points.slice(0, 2);
    prompt = 'Write a status line for the owner, ' + w.owner + ', about ' + sc.topic + '. At most 3 sentences. It must say:\n' + pts.map(x => '- ' + x.say).join('\n');
    exp = { minWords: 12, maxWords: 70, maxSentences: 3, gradeMax: 9, closingAsk: false };
  } else if (p.depth === 'simple') {
    pts = sc.points.slice(0, 3 + (v % 2));
    prompt = 'Write a short reply to the client contact about ' + sc.topic + ', from ' + w.company + '. Between 40 and 150 words. Cover these points:\n' + pts.map(x => '- ' + x.say).join('\n');
    exp = { minWords: 40, maxWords: 150, gradeMax: 9, closingAsk: false };
  } else if (p.depth === 'standard') {
    pts = sc.points.slice(0, 5 + (v % 2));
    files['handoff.md'] = ['# handoff dump (' + day(0) + ')', '', 'ctx: ' + sc.topic + ' -- see ' + sc.internal[0] + ', also ' + sc.internal[1] + '. ' + pts.map(x => x.say.replace(/\.$/, '').toLowerCase()).join('; ') + '.',
      '', 'pls turn into a note for ' + w.owner + ' (owner, not technical). keep internal refs out.', '', CANARY_LINE].join('\n') + '\n';
    prompt = 'Turn the handoff into a plain note for the owner, ' + w.owner + '. Between 80 and 220 words. Keep every point from the handoff; leave out internal references (ticket numbers, file names, ids).';
    exp = { minWords: 80, maxWords: 220, gradeMax: 10, closingAsk: false, forbid: leakTerms(sc.internal) };
  } else {
    pts = sc.points.slice();
    const rule = 'R' + r.int(3, 9), seat = w.seats[1].name, refused = 'give ' + w.clients[0].contact + ' the login for our shared supplier account';
    pts.push({ say: seat + ' asked to ' + refused + ', and we said no, because our house rule ' + rule + ' says we never share logins or keys outside the company.', q: 'Does the note say we refused to share the login, and why, in plain words?', ev: ['login'] });
    pts.push({ say: 'We are sorry for the trouble this caused.', q: 'Does the note apologise once, without blaming a person?', ev: ['sorry'] });
    files['handoff.md'] = ['# handoff dump (' + day(0) + ')', '', 'ctx: ' + sc.topic + ' -- see ' + sc.internal[0] + ' and ' + sc.internal[1] + '.', pts.map(x => '* ' + x.say.toLowerCase()).join('\n'),
      '', 'owner must decide: ' + sc.ask.say.toLowerCase(), '', CANARY_LINE].join('\n') + '\n';
    prompt = 'Write the note to the owner, ' + w.owner + ', about ' + sc.topic + '. It is bad news. Between 120 and 300 words. Keep every point from the handoff, apologise once, blame no one by name, leave out internal references, and end with the one question the owner must answer.';
    exp = { minWords: 120, maxWords: 300, gradeMax: 10, closingAsk: true, askWords: sc.ask.words };
    exp.forbid = leakTerms(sc.internal);   // the rule number may be named; the internal references may not
  }
  const ask = exp.closingAsk ? sc.ask : null;
  exp.questions = pts.map(x => x.q).concat(ask ? [sc.ask.q] : []);
  exp.evidence = pts.map(x => x.ev).concat(ask ? [sc.ask.words] : []);
  const opener = p.depth === 'simple' ? 'Hello, thank you for your patience. ' : p.depth === 'lookup' ? '' : 'Here is where things stand. ';
  const sents = pts.map(x => x.say);
  let note = opener + sents.join(' ');
  if (p.depth === 'lookup') note = sents.join(' ');
  if (p.depth === 'simple') note += ' Please write back if anything is unclear. Kind regards, the team at ' + w.company + '.';
  if (p.depth === 'standard') note += ' We will keep you posted as this moves on. Nothing here needs a decision from you today, and we will tell you if that changes.';
  // the oracle note is padded with plain, neutral sentences to the task's minimum length
  const PAD = ['We checked the details twice before writing this.', 'Nothing else has changed this week.', 'The rest of the work is on track.',
    'We will keep you posted as this moves on.', 'You do not need to do anything else for now.', 'The team is happy to talk it through.'];
  for (let k = 0; T.words(note).length < exp.minWords + 4 && k < PAD.length; k++) note += ' ' + PAD[k];
  if (ask) note += ' ' + sc.ask.say;
  const bad = 'Quick update: the API endpoint regression is fixed and the deploy went out, see ' + sc.internal[0] + '. ' + sents.slice(0, 1).join(' ');
  return { prompt, files, expected: exp, oracle: { answer: { note } }, bad: { answer: { note: bad } } };
}
// the stub judge for tests: a question is "yes" when its evidence words are in the note (never used for a real run)
function stubJudge(exp) {
  return async (questions, note) => ({ answers: questions.map((q, i) => ({ q: i + 1, yes: (exp.evidence[i] || []).some(e => note.toLowerCase().includes(String(e).toLowerCase())), why: 'stub' })) });
}
module.exports = { generate, stubJudge };
