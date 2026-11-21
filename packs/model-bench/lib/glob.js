'use strict';
// minimal globs for scope checks: ** any depth, * within one folder, ? one character
function re(g) {
  let s = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { s += '.*'; i++; if (g[i + 1] === '/') i++; }
    else if (c === '*') s += '[^/]*';
    else if (c === '?') s += '[^/]';
    else s += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + s + '$');
}
const any = (globs, p) => (globs || []).some(g => re(g).test(p));
// the files that differ between two trees (path -> hash maps)
function changed(before, after) {
  const out = [];
  for (const k of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) if ((before || {})[k] !== (after || {})[k]) out.push(k);
  return out.sort();
}
module.exports = { re, any, changed };
