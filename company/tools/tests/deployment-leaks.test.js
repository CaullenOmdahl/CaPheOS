#!/usr/bin/env node
/* deployment-leaks.test.js — scripts/check-deployment-leaks.js finds a company's own words and nothing else.
 *   node --test company/tools/tests/deployment-leaks.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const L = require('../../../scripts/check-deployment-leaks.js');

test('crew, company and folder names from the companies on the machine are found; neutral text and seat titles are not', () => {
  const dir = require('../lib/temp-life').tmpDir('leaks-');
  try {
    const co = path.join(dir, 'acme-trading');
    fs.mkdirSync(path.join(co, 'company', 'tools'), { recursive: true });
    fs.writeFileSync(path.join(co, 'company', 'company.json'), JSON.stringify({ name: 'Acme Trading', owner: { name: 'Quentin Zorro' } }));
    fs.writeFileSync(path.join(co, 'company', 'tools', 'loops.json'), JSON.stringify({ agents: { agent: { name: 'Founder' }, 'cand-x': { name: 'Wilhelmina Gorse' } } }));
    const W = L.words({ companiesDir: dir });
    assert.ok(W.words.has('Wilhelmina') && W.words.has('Acme Trading') && W.words.has('acme-trading') && W.words.has('Zorro'));
    assert.ok(!W.words.has('Founder'), 'a seat title is not a name');
    const re = L.matcher(W.words);
    const hits = L.scanLines([
      { file: 'a.js', line: 1, text: "const crew = { w: { name: 'Wilhelmina Gorse' } };" },
      { file: 'b.md', line: 2, text: 'see company/work/handoffs/to-wilhelmina.md' },
      { file: 'c.js', line: 3, text: "assert.match(x, /\\nWilhelmina answers/);" },
      { file: 'd.js', line: 4, text: "const crew = { a: { name: 'Alex' }, f: { name: 'Founder' } };" },
      { file: 'e.md', line: 5, text: 'Wilhelminas and AcmeTradingX are other words' },
    ], re, W.words);
    assert.deepEqual(hits.map(h => h.line), [1, 2, 3]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('no company on the machine: no words, nothing to check', () => {
  const dir = require('../lib/temp-life').tmpDir('leaks-empty-');
  try { const W = L.words({ companiesDir: dir }); assert.equal(W.companies, 0); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
