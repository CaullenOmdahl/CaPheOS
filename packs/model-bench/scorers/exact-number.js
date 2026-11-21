'use strict';
/* Kind 5, numbers. Every named value must equal the program-computed answer at the stated precision (currency signs and
 * separators do not count), and the unit is required. Deep: the discrepancies too, scored recall minus false-alarm rate. */
const A = require('../lib/answer');
async function score(ans, exp, ctx) {
  ans = ans || {};
  const prec = (ctx && ctx.args && ctx.args.precision != null) ? ctx.args.precision : (exp.precision == null ? 2 : exp.precision);
  const bad = [];
  const r = x => Math.round(x * 10 ** prec) / 10 ** prec;
  const vals = exp.values || { value: exp.value };
  const got = exp.values ? (ans.values || {}) : { value: ans.value };
  for (const [k, v] of Object.entries(vals)) { const n = A.num(got[k]); if (Number.isNaN(n) || r(n) !== r(v)) bad.push(k + ': wanted ' + r(v) + ', got ' + JSON.stringify(got[k])); }
  const needUnit = !ctx || !ctx.args || ctx.args.unit !== 'none';
  if (needUnit && exp.unit && A.norm(ans.unit) !== A.norm(exp.unit)) bad.push('unit: wanted ' + exp.unit + ', got ' + JSON.stringify(ans.unit));
  let s = bad.length ? 0 : 1, extra = '';
  if (exp.discrepancies) {
    const want = exp.discrepancies.map(d => A.norm(d.ref) + '|' + A.norm(d.type));
    const gotD = (ans.discrepancies || []).map(d => A.norm(d && d.ref) + '|' + A.norm(d && d.type));
    const hit = new Set(gotD.filter(x => want.includes(x)));
    const recall = hit.size / Math.max(1, want.length), fa = gotD.filter(x => !want.includes(x)).length / Math.max(1, gotD.length);
    const ds = recall - fa; extra = '; discrepancies recall ' + recall.toFixed(2) + ' false-alarm ' + fa.toFixed(2);
    if (ds < (exp.discrepancyMin || 0.9) - 1e-9) bad.push('discrepancy score ' + ds.toFixed(2) + ' under ' + (exp.discrepancyMin || 0.9));
    s = bad.length ? Math.max(0, Math.min(s, ds)) : ds;
  }
  return { pass: !bad.length, score: Math.round(s * 1000) / 1000, detail: (bad.join('; ') || 'every number right') + extra };
}
module.exports = { score };
