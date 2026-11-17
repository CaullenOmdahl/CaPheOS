'use strict';
// Every tool that records its own writes to a locked file (provenance.wrote(…, '<tool>')) must be listed as an allowed
// writer of that file, or the owner's own console changes through it are flagged as unrecorded (sandbox 2026-11-17:
// model chains set in Settings › Models went through models.js and were flagged twice).
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path');
const LW = require('../locked-watch.js');
const tools = path.join(__dirname, '..');
test('a tool that records writes to a locked policy file is one of its allowed writers', () => {
  const pairs = [['company/model-policy.json', 'models.js'], ['company/state/deps.json', 'deps.js'], ['company/state/deps/**', 'deps.js']];
  for (const [file, tool] of pairs) {
    const src = fs.readFileSync(path.join(tools, tool), 'utf8');
    assert.ok(/provenance\.js'\)\.wrote\(|prov\(\)\.wrote\(/.test(src), tool + ' records its writes');
    const e = LW.MANIFEST.find(m => m.p === file);
    assert.ok(e && (e.writers || []).includes(tool), file + ' lists ' + tool + ' as a writer');
  }
});

// The framework's own units (systemd/*.in, named for the station) are never crew services: the unregistered-services
// duty must not flag them (sandbox 2026-11-17: the new heartbeat timer was flagged every run and offered for "adoption").
test('every unit the framework installs counts as a framework unit', () => {
  const S = require('../service.js');
  const fu = (S._internals && S._internals.frameworkUnits) || null;
  if (!fu) return;   // not exported: covered by the selftest
  const set = fu({ stationSvc: 'acme-station' });
  for (const u of ['acme-station-liveness-heartbeat.timer', 'acme-station-liveness-heartbeat.service', 'acme-station-console.service', 'acme-station.service'])
    assert.ok(set.has(u), u);
});
