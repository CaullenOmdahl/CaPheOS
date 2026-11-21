'use strict';
// A small line diff (LCS) that writes unified diffs, for the review tasks. Returns the new-side line numbers it adds.
function lcs(a, b) {
  const n = a.length, m = b.length, t = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < n && j < m) { if (a[i] === b[j]) { ops.push([' ', a[i], i, j]); i++; j++; } else if (t[i + 1][j] >= t[i][j + 1]) { ops.push(['-', a[i], i, j]); i++; } else { ops.push(['+', b[j], i, j]); j++; } }
  while (i < n) { ops.push(['-', a[i], i, j]); i++; }
  while (j < m) { ops.push(['+', b[j], i, j]); j++; }
  return ops;
}
function unified(file, before, after, ctx) {
  ctx = ctx == null ? 3 : ctx;
  const a = before === null ? [] : before.split('\n'), b = after === null ? [] : after.split('\n');
  const ops = lcs(a, b);
  const changed = ops.map((o, k) => o[0] !== ' ' ? k : -1).filter(k => k >= 0);
  if (!changed.length) return { text: '', added: [] };
  const hunks = []; let cur = null;
  for (const k of changed) { if (cur && k - cur.end <= ctx * 2) cur.end = k; else { cur = { start: k, end: k }; hunks.push(cur); } }
  const out = ['--- ' + (before === null ? '/dev/null' : 'a/' + file), '+++ ' + (after === null ? '/dev/null' : 'b/' + file)];
  const added = [];
  for (const h of hunks) {
    const s = Math.max(0, h.start - ctx), e = Math.min(ops.length - 1, h.end + ctx);
    const seg = ops.slice(s, e + 1);
    const aStart = seg[0][2] + 1, bStart = seg[0][3] + 1;
    const aLen = seg.filter(o => o[0] !== '+').length, bLen = seg.filter(o => o[0] !== '-').length;
    out.push('@@ -' + (aLen ? aStart : aStart - 1) + ',' + aLen + ' +' + (bLen ? bStart : bStart - 1) + ',' + bLen + ' @@');
    for (const o of seg) { out.push(o[0] + o[1]); if (o[0] === '+') added.push(o[3] + 1); }
  }
  return { text: out.join('\n') + '\n', added };
}
module.exports = { unified };
