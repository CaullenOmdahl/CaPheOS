'use strict';
// Seeded randomness for the generators: the same (seed, task id, version) always gives the same instance.
const crypto = require('crypto');

function hash32(s) { return crypto.createHash('sha256').update(String(s)).digest().readUInt32LE(0); }
function rng(seed) {
  let a = hash32(seed) >>> 0;
  const next = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const r = {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: arr => arr[Math.floor(next() * arr.length)],
    chance: p => next() < p,
    shuffle: arr => { const a2 = arr.slice(); for (let i = a2.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [a2[i], a2[j]] = [a2[j], a2[i]]; } return a2; },
    sample: (arr, n) => r.shuffle(arr).slice(0, n),
    hex: n => { let s = ''; while (s.length < n) s += Math.floor(next() * 16).toString(16); return s; },
    // money in cents, a multiple of `step` cents
    cents: (lo, hi, step) => { step = step || 1; return Math.round(r.int(Math.ceil(lo / step), Math.floor(hi / step)) * step); },
  };
  return r;
}
module.exports = { rng, hash32 };
