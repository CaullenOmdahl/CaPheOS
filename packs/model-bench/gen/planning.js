'use strict';
/* Kind 4, planning: seeded seats, dependencies, availability, a budget and an owner-approval gate. Shapes taken from
 * NATURAL PLAN (hard constraints, one checkable answer), TravelPlanner (every constraint must hold), PlanBench (the same
 * problem renamed on every instance, checked by simulating the plan) and ACPBench (single probes). Items are our own.
 *   lookup: a probe (which step must come first / last, how many steps before X)
 *   simple: 4-6 steps and 1-2 ordering rules -> an order
 *   standard: 8-12 steps, durations, seat skills and availability, a deadline, a budget, the approval gate -> a schedule
 *   deep: the same, but the constraints are only in the workspace files (some only in the calendar and the rules) */
const { CANARY_LINE } = require('../lib/world');

const WORK = [['Collect the receipts', 'finance'], ['Check the stock list', 'ops'], ['Draft the client letter', 'writing'], ['Price the new job', 'finance'],
  ['Book the van', 'ops'], ['Order the materials', 'ops', true], ['Update the price list', 'writing'], ['Fix the booking form', 'engineering'],
  ['Test the booking form', 'engineering'], ['Send the invoices', 'finance'], ['Order new shelving', 'ops', true], ['Write the newsletter', 'writing'],
  ['Renew the software licence', 'engineering', true], ['Reconcile the bank account', 'finance'], ['Photograph the samples', 'design'], ['Lay out the catalogue', 'design']];

function ids(r, n) { return r.shuffle(Array.from({ length: n }, (_, i) => 'S' + (i + 1))); }

function generate(r, p, ctx) {
  const W = ctx.W, w = W.world(r, { seats: 5 }), v = Number(p.variant) || 1;
  const goal = r.pick(['get the spring catalogue out', 'move the stockroom', 'start work for a new client', 'close the quarter', 'launch the booking page']);
  if (p.depth === 'lookup') {
    const n = 5 + (v % 3), order = ids(r, n), work = r.sample(WORK, n);
    const deps = {}; order.forEach((s, i) => { deps[s] = i === 0 ? [] : [order[r.int(0, i - 1)]]; if (i > 1 && r.chance(0.4)) deps[s].push(order[r.int(0, i - 1)]); deps[s] = [...new Set(deps[s])]; });
    const kind = v % 3;
    let q, answer;
    if (kind === 1) { q = 'Which step must come first?'; answer = order[0]; }
    else if (kind === 2) { const last = 'S' + (n + 1); order.push(last); work.push(['Send the owner the summary', 'writing']); deps[last] = order.slice(0, n).filter(s => !order.some(t => (deps[t] || []).includes(s))); q = 'Which step can only be done last?'; answer = last; }
    else { const x = order[n - 1]; const anc = new Set(); const walk = s => { for (const d of deps[s]) if (!anc.has(d)) { anc.add(d); walk(d); } }; walk(x); q = 'How many other steps must be finished before ' + x + ' can start?'; answer = String(anc.size); }
    const list = [...order].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).map(s => s + ': ' + work[order.indexOf(s)][0] + (deps[s].length ? ' (needs ' + deps[s].join(', ') + ' done first)' : ''));
    return { prompt: 'To ' + goal + ', the crew has these steps:\n' + list.join('\n') + '\n\n' + q + ' Answer with the step id, or the number.', files: {}, expected: { mode: 'probe', answer },
      oracle: { answer: { answer } }, bad: { answer: { answer: kind === 0 ? String(Number(answer) + 1) : order[1] } } };
  }
  if (p.depth === 'simple') {
    const n = 4 + (v % 3), order = ids(r, n), work = r.sample(WORK, n);
    const rules = []; const nr = 1 + (v % 2);
    while (rules.length < nr) { const i = r.int(0, n - 2), j = r.int(i + 1, n - 1); if (!rules.some(x => x[0] === order[i] && x[1] === order[j])) rules.push([order[i], order[j]]); }
    const list = [...order].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).map(s => s + ': ' + work[order.indexOf(s)][0]);
    const sorted = [...order].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    const badOrder = sorted.slice(); const [a, b] = rules[0]; const ia = badOrder.indexOf(a), ib = badOrder.indexOf(b); if (ia < ib) { badOrder[ia] = b; badOrder[ib] = a; }
    return { prompt: 'To ' + goal + ', put every step below in an order the crew can follow. Rules:\n' + rules.map(x => '- ' + x[0] + ' must be done before ' + x[1] + '.').join('\n') + '\n\nSteps:\n' + list.join('\n'),
      files: {}, expected: { mode: 'order', required: sorted, before: rules }, oracle: { answer: { steps: topo(sorted, rules) } }, bad: { answer: { steps: badOrder } } };
  }
  // standard and deep: a schedule
  const deep = p.depth === 'deep';
  const n = 8 + (v % 5), order = ids(r, n), work = r.sample(WORK, n);
  const steps = order.map((id, i) => ({ id, title: work[i][0], skill: work[i][1], buys: !!work[i][2], days: r.int(1, 3), after: [] }));
  steps.forEach((s, i) => { if (i > 0 && r.chance(0.7)) s.after.push(steps[r.int(0, i - 1)].id); if (i > 2 && r.chance(0.3)) s.after.push(steps[r.int(0, i - 1)].id); s.after = [...new Set(s.after)]; });
  // the owner-approval gate: every step that buys something waits for it
  const gate = { id: 'S' + (n + 1), title: 'Owner approves the spend', skill: 'approval', buys: false, days: 1, after: [] };
  if (!steps.some(s => s.buys)) steps[steps.length - 1].buys = true;
  for (const s of steps) if (s.buys) s.after.push(gate.id);
  steps.unshift(gate);
  const skills = ['finance', 'ops', 'writing', 'engineering', 'design'];
  const seats = w.seats.slice(0, 4).map((s, i) => ({ id: 'seat-' + s.name.split(' ')[0].toLowerCase(), name: s.name, skills: [skills[i], skills[(i + 1) % 5]], days: [], dayRate: 0 }));
  seats.push({ id: 'seat-contractor', name: w.person() + ' (contractor)', skills: skills.slice(), days: [], dayRate: r.int(2, 4) * 100 });
  seats.push({ id: 'seat-owner', name: w.owner + ' (owner)', skills: ['approval'], days: [], dayRate: 0 });
  // build a valid schedule first (in-house seats first), then write availability and limits around it
  const plan = [], busy = {}, endOf = {};
  const horizon = 40;
  const ownerDays = [r.int(1, 3), r.int(4, 6), r.int(7, 9)];
  for (const s of topoSteps(steps)) {
    const ready = Math.max(1, ...s.after.map(a => endOf[a] + 1));
    const cands = seats.filter(x => x.skills.includes(s.skill)).sort((a, b) => a.dayRate - b.dayRate);
    let best = null;
    for (const seat of cands) for (let d = ready; d < horizon; d++) {
      if (seat.id === 'seat-owner' && !ownerDays.includes(d)) continue;
      let ok = true; for (let k = 0; k < s.days; k++) if (busy[seat.id + '@' + (d + k)]) ok = false;
      if (ok) { if (!best || d < best.d) best = { seat, d }; break; }   // the earliest start; cheaper seats first on a tie
    }
    plan.push({ step: s.id, seat: best.seat.id, day: best.d });
    for (let k = 0; k < s.days; k++) { busy[best.seat.id + '@' + (best.d + k)] = s.id; best.seat.days.push(best.d + k); }
    endOf[s.id] = best.d + s.days - 1;
  }
  const end = Math.max(...Object.values(endOf));
  const deadline = end + r.int(0, 1);
  for (const seat of seats) {
    if (seat.id === 'seat-owner') { seat.days = ownerDays.slice(); continue; }
    const extra = []; for (let d = 1; d <= deadline; d++) if (!seat.days.includes(d) && r.chance(0.55)) extra.push(d);
    seat.days = [...new Set(seat.days.concat(extra))].sort((a, b) => a - b);
  }
  const cost = plan.reduce((a, x) => a + steps.find(s => s.id === x.step).days * seats.find(s => s.id === x.seat).dayRate, 0);
  const budget = cost + (cost ? 0 : r.int(0, 1) * 100);
  const exp = { mode: 'schedule', steps: steps.map(s => ({ id: s.id, skill: s.skill, days: s.days, after: s.after })), seats: seats.map(s => ({ id: s.id, skills: s.skills, days: s.days, dayRate: s.dayRate })), deadline, budget };
  const stepLine = (s, withGate) => s.id + ': ' + s.title + ' - needs ' + s.skill + ', ' + s.days + ' day' + (s.days > 1 ? 's' : '') +
    ((withGate ? s.after : s.after.filter(a => a !== gate.id)).length ? ', after ' + (withGate ? s.after : s.after.filter(a => a !== gate.id)).join(', ') : '') + (s.buys && !withGate ? ' (buys something)' : '');
  const seatLine = s => s.id + ' (' + s.name + '): does ' + s.skills.join(', ') + '; free on days ' + compress(s.days) + (s.dayRate ? '; costs ' + s.dayRate + ' ' + w.currency + ' a day' : '');
  const bad = plan.map(x => Object.assign({}, x)); { const k = bad.findIndex(x => steps.find(s => s.id === x.step).after.length); const i = k >= 0 ? k : 1; bad[i].day = 1; }
  const answerHelp = 'Give every step with the seat that does it and the day it starts (day 1 is the first day). A step of several days runs on consecutive days, and a seat does one step at a time.';
  if (!deep) {
    const prompt = 'Plan the work to ' + goal + '. ' + answerHelp + '\n\nSteps:\n' + steps.map(s => stepLine(s, true)).join('\n') + '\n\nSeats:\n' + seats.map(seatLine).join('\n') +
      '\n\nEverything must be finished by the end of day ' + deadline + '. The total cost of contractor days may not be more than ' + budget + ' ' + w.currency + '.';
    return { prompt, files: {}, expected: exp, oracle: { answer: { plan } }, bad: { answer: { plan: bad } } };
  }
  // deep: the gate, the deadline, the budget and some days off are only in the files
  const off = []; for (const seat of seats.filter(s => s.dayRate === 0 && s.id !== 'seat-owner')) for (let d = 1; d <= deadline; d++) if (!seat.days.includes(d) && r.chance(0.5)) off.push([seat.id, d]);
  const listed = seats.map(s => s.id === 'seat-owner' ? s : Object.assign({}, s, { days: [...new Set(s.days.concat(off.filter(o => o[0] === s.id).map(o => o[1])))].sort((a, b) => a - b) }));
  const files = {
    'plan/steps.md': '# Steps\n\n' + steps.filter(s => s.id !== gate.id).map(s => '- ' + stepLine(s, false)).join('\n') + '\n\n<!-- ' + CANARY_LINE + ' -->\n',
    'plan/seats.md': '# Seats and their usual free days\n\n' + listed.filter(s => s.id !== 'seat-owner').map(s => '- ' + seatLine(s)).join('\n') + '\n\n<!-- ' + CANARY_LINE + ' -->\n',
    'plan/calendar.md': '# Calendar changes this period\n\n' + (off.length ? off.map(o => '- ' + o[0] + ' is off on day ' + o[1] + '.').join('\n') : '- No changes.') + '\n- ' + w.owner + ' (seat-owner) can only give approvals on days ' + ownerDays.join(', ') + '.\n\n<!-- ' + CANARY_LINE + ' -->\n',
    'plan/rules.md': '# House rules for this plan\n\n1. Anything that buys something waits for the step "' + gate.id + ': Owner approves the spend" (seat-owner, 1 day, needs approval).\n2. Everything is finished by the end of day ' + deadline + '.\n3. Contractor days in total cost at most ' + budget + ' ' + w.currency + '.\n4. One step at a time per seat; a step of several days runs on consecutive days.\n\n<!-- ' + CANARY_LINE + ' -->\n',
  };
  const prompt = 'Plan the work to ' + goal + '. Everything you need is in the workspace folder plan/. ' + answerHelp + ' Include the approval step if the rules need one.';
  return { prompt, files, expected: exp, oracle: { answer: { plan } }, bad: { answer: { plan: plan.filter(x => x.step !== gate.id) } } };
}
function compress(days) { const out = []; let i = 0; while (i < days.length) { let j = i; while (j + 1 < days.length && days[j + 1] === days[j] + 1) j++; out.push(i === j ? String(days[i]) : days[i] + '-' + days[j]); i = j + 1; } return out.join(', ') || 'none'; }
function topo(ids, rules) { const out = [], left = ids.slice(); while (left.length) { const i = left.findIndex(s => !rules.some(([a, b]) => b === s && left.includes(a))); out.push(left.splice(i, 1)[0]); } return out; }
function topoSteps(steps) { const out = [], left = steps.slice(); while (left.length) { const i = left.findIndex(s => s.after.every(a => out.some(o => o.id === a))); out.push(left.splice(i, 1)[0]); } return out; }
module.exports = { generate };
