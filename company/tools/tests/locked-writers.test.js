'use strict';
// Every tool that records its own writes to a locked file (provenance.wrote(…, '<tool>')) must be listed as an allowed
// writer of that file, or the owner's own console changes through it are flagged as unrecorded (sandbox 2026-11-17:
// model chains set in Settings › Models went through models.js and were flagged twice).
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path');
const LW = require('../locked-watch.js');
const tools = path.join(__dirname, '..');
test('a tool that records writes to a locked policy file is one of its allowed writers', () => {
  const pairs = [['company/model-policy.json', 'models.js'], ['company/state/deps.json', 'deps.js'], ['company/state/deps/**', 'deps.js'], ['company/departments.json', 'departments.js'], ['company/work/models/routing-policy.json', 'routing.js'], ['company/state/owner-rulings.json', 'lib/owner-rulings.js'], ['company/owner/talk.json', 'talk.js']];
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

// A hand edit of a profile, the profile policy or the profile proposals is put back, not only reported (2026-11-19 safety
// re-review: a seat that wrote its own profile with counterpart null dropped its sign-off); the readers also read only what
// profile.js recorded (lib/profile.js loadState, companyPolicy)
test('the profile files are restored on a hand edit (class A, written only by profile.js)', () => {
  for (const p of ['company/people/profiles/*.json', 'company/people/profile-policy.json', 'company/people/profile-proposals.json', 'company/people/profile-policy.history.jsonl', 'company/state/signoffs.jsonl', 'company/work/models/routing-proposals.jsonl']) {
    const e = LW.MANIFEST.find(m => m.p === p);
    assert.ok(e, p); assert.equal(e.cls, 'A', p);
  }
  assert.ok(LW.MANIFEST.find(m => m.p === 'company/people/profile-policy.history.jsonl').append);
});
