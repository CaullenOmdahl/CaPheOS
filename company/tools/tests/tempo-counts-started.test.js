'use strict';
/* The tempo caps count wakes that really started, not wakes held afterwards by a model, quota, refusal or route hold
 * (2026-11-19: the developing company recorded 1,511 "wakes" for ~370 runs and froze on its own 120-a-day cap). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const REPO = path.resolve(__dirname, '..', '..', '..');

test('dispatch.js asks the tempo caps without recording, and records only just before RUN', () => {
  const src = fs.readFileSync(path.join(REPO, 'company', 'tools', 'dispatch.js'), 'utf8');
  assert.match(src, /tempoAllows\(agentId, Date\.now\(\), \{ record: false/, 'the check does not record');
  const rec = src.indexOf('recordWake(agentId'), run = src.indexOf("log('RUN ' + job.name");
  const holds = ['NO MODEL HOLD', 'QUOTA HOLD', 'REFUSAL HOLD', 'ROUTE HOLD'].map(h => src.indexOf("log('" + h));
  assert.ok(rec > 0 && run > rec, 'recorded right before the RUN line');
  for (const h of holds) assert.ok(h > 0 && h < rec, 'every hold comes before the record');
});

test('recordWake counts; tempoAllows without record does not', () => {
  const C = require(path.join(REPO, 'company', 'tools', 'cadence.js'));
  const life = require(path.join(REPO, 'company', 'tools', 'lib', 'temp-life.js'));
  const tmp = life.tmpDir('tempo-count-');
  const saved = C.S.wakesFile;
  try {
    C.S.wakesFile = path.join(tmp, 'tempo-wakes.json');
    const now = Date.now();
    C.tempoAllows('desk', now); C.tempoAllows('desk', now + 1);
    assert.equal(C.wakeCounts(now + 2).day, 0, 'asking never counts');
    C.recordWake('desk', now + 3);
    assert.equal(C.wakeCounts(now + 4).day, 1, 'a started wake counts');
  } finally { C.S.wakesFile = saved; life.cleanup(); }
});
