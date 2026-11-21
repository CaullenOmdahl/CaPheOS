'use strict';
/* Kind 4, planning. probe: one exact answer. order: the numbered step list must hold every required step once and keep
 * every ordering rule. schedule: a simulator replays the plan (step, seat, day): each step once, the seat has the skill and
 * is free on every day it works, no seat does two steps at once, dependencies end before a step starts, windows and the
 * deadline hold, the owner-approval gate comes first, and the total cost stays in the budget. Every constraint must hold. */
const A = require('../lib/answer');
async function score(ans, exp) {
  ans = ans || {};
  if (exp.mode === 'probe') { const ok = A.same(ans.answer, exp.answer); return { pass: ok, score: ok ? 1 : 0, detail: ok ? 'right' : 'wanted ' + exp.answer + ', got ' + JSON.stringify(ans.answer) }; }
  const bad = [];
  if (exp.mode === 'order') {
    const steps = (ans.steps || []).map(String);
    const want = new Set(exp.required);
    for (const s of steps) if (!want.has(s)) bad.push('unknown or extra step ' + s);
    for (const s of exp.required) { const c = steps.filter(x => x === s).length; if (c !== 1) bad.push(s + ' appears ' + c + ' times'); }
    for (const [a, b] of exp.before) if (steps.indexOf(a) < 0 || steps.indexOf(b) < 0 || steps.indexOf(a) > steps.indexOf(b)) bad.push(a + ' must come before ' + b);
    return { pass: !bad.length, score: bad.length ? 0 : 1, detail: bad.join('; ') || 'every rule holds' };
  }
  // schedule
  const plan = Array.isArray(ans.plan) ? ans.plan : [];
  const byStep = new Map();
  for (const p of plan) { const id = String(p && p.step); if (byStep.has(id)) bad.push(id + ' is planned twice'); byStep.set(id, { seat: String(p.seat), day: Number(p.day) }); }
  const steps = new Map(exp.steps.map(s => [s.id, s]));
  for (const id of byStep.keys()) if (!steps.has(id)) bad.push('unknown step ' + id);
  const busy = {};
  let cost = 0;
  for (const s of exp.steps) {
    const p = byStep.get(s.id);
    if (!p) { bad.push(s.id + ' is missing'); continue; }
    if (!Number.isInteger(p.day) || p.day < 1) { bad.push(s.id + ' has no whole start day'); continue; }
    const seat = exp.seats.find(x => x.id === p.seat);
    if (!seat) { bad.push(s.id + ' goes to an unknown seat ' + p.seat); continue; }
    if (!seat.skills.includes(s.skill)) bad.push(s.id + ' needs ' + s.skill + ', which ' + seat.id + ' does not do');
    const end = p.day + s.days - 1;
    for (let d = p.day; d <= end; d++) {
      if (!seat.days.includes(d)) bad.push(seat.id + ' is not available on day ' + d + ' (' + s.id + ')');
      const k = seat.id + '@' + d; if (busy[k]) bad.push(seat.id + ' does ' + busy[k] + ' and ' + s.id + ' on day ' + d); busy[k] = s.id;
    }
    for (const dep of s.after || []) { const q = byStep.get(dep), ds = steps.get(dep); if (q && ds && q.day + ds.days - 1 >= p.day) bad.push(s.id + ' starts before ' + dep + ' ends'); }
    if (s.earliest && p.day < s.earliest) bad.push(s.id + ' starts before day ' + s.earliest);
    if (s.latestEnd && end > s.latestEnd) bad.push(s.id + ' ends after day ' + s.latestEnd);
    if (exp.deadline && end > exp.deadline) bad.push(s.id + ' ends after the deadline, day ' + exp.deadline);
    cost += s.days * (seat.dayRate || 0);
  }
  if (exp.budget != null && cost > exp.budget) bad.push('costs ' + cost + ', over the budget of ' + exp.budget);
  return { pass: !bad.length, score: bad.length ? 0 : 1, detail: bad.slice(0, 8).join('; ') || 'every constraint holds (cost ' + cost + ')' };
}
module.exports = { score };
