'use strict';
/* Kind 8, code review. A finding counts when it names the right file, a line within +-3 of the planted bug and the right
 * bug class (by rule). Score = recall - false-alarm rate (unmatched findings / findings); style nits are ignored. A clean
 * change must be approved with no findings at all. */
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
  const used = new Set(); let tp = 0; const miss = [];
  for (const f of fs_) {
    const i = exp.bugs.findIndex((b, k) => !used.has(k) && A.norm(f.file).replace(/^[ab]\//, '') === A.norm(b.file) && Math.abs(Number(f.line) - b.line) <= tol && [b.class].concat(b.alts || []).map(A.norm).includes(A.norm(f.class)));
    if (i >= 0) { used.add(i); tp++; }
  }
  exp.bugs.forEach((b, k) => { if (!used.has(k)) miss.push(b.file + ':' + b.line + ' ' + b.class); });
  const recall = tp / exp.bugs.length, fa = (fs_.length - tp) / Math.max(1, fs_.length), s = recall - fa;
  const pass = s >= 0.9 - 1e-9 && verdict === 'request_changes';
  return { pass, score: Math.round(s * 1000) / 1000, detail: 'recall ' + recall.toFixed(2) + ', false alarms ' + (fs_.length - tp) + ', verdict ' + verdict + (miss.length ? '; missed ' + miss.join(', ') : '') };
}
module.exports = { score };
