#!/usr/bin/env node
/* cadence-schedule-note.test.js — a schedule set by cadence.js leaves a provenance note locked-watch can trust, so the
 * tool's own change is not flagged as an unreviewed schedule edit; other note kinds are still refused.
 *   node --test company/tools/tests/cadence-schedule-note.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const prov = require('../provenance.js');

test('noted(kind schedule) records the job, cron and zone under the writer; an unknown kind is not recorded', () => {
  const root = require('../lib/temp-life').tmpDir('cad-note-');
  try {
    fs.mkdirSync(path.join(root, 'company', 'work', 'ops'), { recursive: true });
    const f = path.join(root, 'company', 'work', 'ops', 'cadence.json'); fs.writeFileSync(f, '{}');
    assert.equal(prov.noted(f, { kind: 'schedule', jobId: 'job-1', expr: '0 21 * * 6', tz: 'Asia/Ho_Chi_Minh' }, 'cadence.js', { root }), true);
    assert.equal(prov.noted(f, { kind: 'whatever', jobId: 'job-1' }, 'cadence.js', { root }), false);
    const rows = fs.readFileSync(prov.logFile(root), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].file, rows[0].kind, rows[0].jobId, rows[0].expr, rows[0].tz, rows[0].writer], ['company/work/ops/cadence.json', 'schedule', 'job-1', '0 21 * * 6', 'Asia/Ho_Chi_Minh', 'cadence.js']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
