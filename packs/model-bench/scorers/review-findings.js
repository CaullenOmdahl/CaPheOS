'use strict';
/* Kind 8, code review. A finding counts when it names the right file, a line within +-3 of the planted bug's lines (a bug
 * may span several: line to end) and the right bug class (by rule). A further finding inside a bug already found is a
 * duplicate: neither a hit nor a false alarm. Score = recall - false-alarm rate (unmatched findings / findings); style
 * nits are ignored. A clean change must be approved with no findings at all. */
const A = require('../lib/answer');
const STYLE = new Set(['style', 'nit', 'naming', 'formatting']);
async function score(ans, exp, ctx) {
  ans = ans || {};
  const tol = (ctx && ctx.args && ctx.args.lineTolerance) || 3;
  const fs_ = (Array.isArray(ans.findings) ? ans.findings : []).filter(f => f && !STYLE.has(A.norm(f.class)));
  const verdict = A.norm(ans.verdict).replace(/\s+/g, '_');
  if (exp.clean) {
    const ok = verdict === 'approve' && fs_.length === 0;
    return { pass: ok, score: ok ? 1 : 0, detail: ok ? 'clean change approved' : 'a clean change got ' + fs_.length + ' finding(s), verdict ' + verdict };
  }
  const near = (f, b) => A.norm(f.file).replace(/^[ab]\//, '') === A.norm(b.file) && Number(f.line) >= b.line - tol && Number(f.line) <= (b.end || b.line) + tol;
  const used = new Set(), hit = new Set(); let tp = 0; const miss = [];
  fs_.forEach((f, n) => {
    const i = exp.bugs.findIndex((b, k) => !used.has(k) && near(f, b) && [b.class].concat(b.alts || []).map(A.norm).includes(A.norm(f.class)));
    if (i >= 0) { used.add(i); hit.add(n); tp++; }
  });
  const dup = fs_.filter((f, n) => !hit.has(n) && exp.bugs.some((b, k) => used.has(k) && near(f, b))).length;
  exp.bugs.forEach((b, k) => { if (!used.has(k)) miss.push(b.file + ':' + b.line + ' ' + b.class); });
  const counted = fs_.length - dup;
  const recall = tp / exp.bugs.length, fa = (counted - tp) / Math.max(1, counted), s = recall - fa;
  const pass = s >= 0.9 - 1e-9 && verdict === 'request_changes';
  return { pass, score: Math.round(s * 1000) / 1000, detail: 'recall ' + recall.toFixed(2) + ', false alarms ' + (counted - tp) + (dup ? ', duplicates ' + dup : '') + ', verdict ' + verdict + (miss.length ? '; missed ' + miss.join(', ') : '') };
}
module.exports = { score };
