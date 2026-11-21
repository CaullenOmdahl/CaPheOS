'use strict';
// Kind 1, lookup: every item must match its canonical answer exactly (after normalising case, spaces, dates and numbers).
// With needPath, the item must also name the file the fact came from. "not_found" must be given exactly.
const A = require('../lib/answer');
async function score(ans, exp) {
  const got = new Map(((ans && ans.answers) || []).filter(x => x && x.id).map(x => [String(x.id), x]));
  const detail = [];
  let right = 0;
  for (const it of exp.items) {
    const g = got.get(it.id);
    let ok = !!g;
    if (ok && it.notFound) ok = A.norm(g.value) === 'not_found';
    else if (ok) ok = A.same(g.value, it.value) || (it.also || []).some(v => A.same(g.value, v));
    if (ok && exp.needPath && !it.notFound) ok = A.norm(String(g.path || '').replace(/^\.\//, '')) === A.norm(it.path);
    if (ok) right++; else detail.push(it.id + ': wanted ' + (it.notFound ? 'not_found' : JSON.stringify(it.value) + (exp.needPath ? ' from ' + it.path : '')) + ', got ' + (g ? JSON.stringify(g.value) + (exp.needPath ? ' from ' + g.path : '') : 'nothing'));
  }
  return { pass: right === exp.items.length, score: right / exp.items.length, detail: detail.join('; ') || 'all items right' };
}
module.exports = { score };
