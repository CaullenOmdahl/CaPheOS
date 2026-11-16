'use strict';
/* Test stub of StarNet's starnet/frontend/app/agentid.js (same rules: slug ids, 'agent' reserved, upper-case names <= 18). */
function slug(seed) { const s = String(seed == null ? '' : seed).toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 32); return s || 'agent'; }
function alloc(seed, taken) { const has = taken && typeof taken.has === 'function' ? id => taken.has(id) : () => false; const base = slug(seed); let id = base, n = 1; while (id === 'agent' || has(id)) id = base + '-' + (++n); return id; }
function normalizeName(name) { return String(name == null ? '' : name).replace(/\s+/g, ' ').trim().toUpperCase(); }
function nameIssue(name) { const n = normalizeName(name); if (!n) return 'empty'; if (n.length > 18) return 'too-long'; return ''; }
module.exports = { alloc, normalizeName, nameIssue, slug };
