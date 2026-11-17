'use strict';
// Every tool that records its own writes to a locked file (provenance.wrote(…, '<tool>')) must be listed as an allowed
// writer of that file, or the owner's own console changes through it are flagged as unrecorded (sandbox 2026-11-17:
// model chains set in Settings › Models went through models.js and were flagged twice).
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path');
const LW = require('../locked-watch.js');
const tools = path.join(__dirname, '..');
test('a tool that records writes to a locked policy file is one of its allowed writers', () => {
  const pairs = [['company/model-policy.json', 'models.js']];
  for (const [file, tool] of pairs) {
    const src = fs.readFileSync(path.join(tools, tool), 'utf8');
    assert.ok(/provenance\.js'\)\.wrote\(/.test(src), tool + ' records its writes');
    const e = LW.MANIFEST.find(m => m.p === file);
    assert.ok(e && (e.writers || []).includes(tool), file + ' lists ' + tool + ' as a writer');
  }
});
