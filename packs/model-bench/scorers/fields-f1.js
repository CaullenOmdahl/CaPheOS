'use strict';
// Kind 2, extraction: F1 over (key, normalised value) pairs. A value given for a key the documents leave empty is a
// made-up value. List fields count each item as a pair. Yes / no / not_stated answers need a quote that is in the source.
const A = require('../lib/answer');
const normV = (v, type) => {
  if (v == null || v === '') return null;
  if (type === 'date') return A.isoDate(v) || A.norm(v);
  // a count or a percentage copied with its unit ("60 days", "1.5%", "18 months") is the same number
  if (type === 'money' || type === 'int' || type === 'number') { const n = A.num(String(v).trim().replace(/\s*(?:%|percent|days?|months?)$/i, '')); return Number.isNaN(n) ? A.norm(v) : String(Math.round(n * 100) / 100); }
  return A.norm(v);
};
const squash = s => A.norm(s).replace(/[^a-z0-9%]+/g, ' ').trim();
async function score(ans, exp) {
  ans = ans || {};
  const gold = [], pred = [], detail = [];
  const types = exp.types || {};
  for (const [k, v] of Object.entries(exp.fields || {})) {
    if (Array.isArray(v)) for (const x of v) gold.push(k + '=' + normV(x, types[k]));
    else if (v != null) gold.push(k + '=' + normV(v, types[k]));
  }
  let madeUp = 0;
  const got = ans.fields || {};
  for (const [k, v] of Object.entries(got)) {
    if (!(k in (exp.fields || {}))) continue;   // keys we did not ask for are ignored
    const g = exp.fields[k];
    if (Array.isArray(v)) { for (const x of v) { const n = normV(x, types[k]); if (n != null) pred.push(k + '=' + n); } if ((!g || (Array.isArray(g) && !g.length)) && v.length) { madeUp++; detail.push(k + ' is not in the documents'); } continue; }
    const n = normV(v, types[k]);
    if (n == null) continue;
    pred.push(k + '=' + n);
    if (g == null) { madeUp++; detail.push(k + ' is not in the documents, got ' + JSON.stringify(v)); }
  }
  // yes / no / not_stated questions, each with a quote that must appear in the source (not needed for not_stated)
  const src = squash(exp.sourceText || '');
  const qs = new Map(((ans.answers) || []).filter(x => x && x.id).map(x => [String(x.id), x]));
  for (const q of exp.questions || []) {
    gold.push('q:' + q.id + '=' + q.label);
    const g = qs.get(q.id); if (!g) continue;
    const label = A.norm(g.label).replace(/[\s-]+/g, '_');
    const quoteOk = label === 'not_stated' || (g.quote && squash(g.quote).length >= 8 && src.includes(squash(g.quote)));
    if (!quoteOk) detail.push(q.id + ': the quote is not in the documents');
    pred.push('q:' + q.id + '=' + (quoteOk ? label : 'bad-quote'));
  }
  const gs = new Map(); for (const x of gold) gs.set(x, (gs.get(x) || 0) + 1);
  let tp = 0; for (const x of pred) if (gs.get(x) > 0) { tp++; gs.set(x, gs.get(x) - 1); }
  const prec = pred.length ? tp / pred.length : (gold.length ? 0 : 1), rec = gold.length ? tp / gold.length : 1;
  const f1 = prec + rec ? 2 * prec * rec / (prec + rec) : 0;
  const thr = exp.threshold == null ? 1 : exp.threshold;
  const pass = f1 >= thr - 1e-9 && (thr >= 1 || madeUp === 0);
  for (const x of gold) if (!pred.includes(x)) detail.push('missed ' + x);
  return { pass, score: Math.round(f1 * 1000) / 1000, detail: 'F1 ' + f1.toFixed(3) + ', made-up ' + madeUp + (detail.length ? '; ' + detail.slice(0, 8).join('; ') : '') };
}
module.exports = { score };
