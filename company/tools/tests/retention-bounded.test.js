'use strict';
// retention-bounded.test.js — the readers stay bounded and the checks stay whole after a retention roll (docs/RETENTION.md):
//  1. external-gate.js reads the end of a large runs.jsonl, not all of it, inside a time bound, and still finds a CEO run
//     from weeks ago (the binary search) for an old clearance row;
//  2. competence.js verify still checks every anchor after decisions.md and the dispatch log rolled (live + archive index).
// (retention.js selftest covers the roll itself: every byte kept, idempotent, locked-watch quiet; ledger.js --selftest
// covers the ledger's anchored chain verify.)
//   node --test company/tools/tests/retention-bounded.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-bounded-selftest-'));
process.env.CAPHEOS_ROOT = T; process.env.COMPETENCE_ROOT = T; process.env.PROVENANCE_ROOT = T; process.env.STARNET_URL = process.env.STARNET_URL || 'http://127.0.0.1:1';   // never a real station
const test = require('node:test');
const assert = require('assert');
const W = (rel, txt) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); return f; };
const DEFAULTS = path.join(__dirname, '..', '..', 'defaults', 'work', 'ops', 'retention.json');

test('external-gate: a large runs.jsonl is read from its end, inside a time bound', () => {
  const G = require('../external-gate.js');
  const CEO = G.CLEARING_AGENT;
  const now = Date.now(); const pad = 'x'.repeat(6000);   // a real run row is ~6 KB
  const f = path.join(T, 'runs-big.jsonl'); const fd = fs.openSync(f, 'w');
  const N = 10000; const old = { runId: 'run-ceo-old', agentId: CEO, startedAt: now - 40 * 86400e3, endedAt: now - 40 * 86400e3 + 600e3 };
  fs.writeSync(fd, JSON.stringify(old) + '\n');
  for (let i = 0; i < N; i++) {
    const end = now - 40 * 86400e3 + (i + 1) * (40 * 86400e3 / N);
    fs.writeSync(fd, JSON.stringify({ runId: 'r' + i, agentId: 'worker', startedAt: end - 300e3, endedAt: end, pad }) + '\n');
  }
  fs.closeSync(fd);
  const size = fs.statSync(f).size; assert.ok(size > 50e6, 'fixture is ' + size + ' bytes');
  G._internals.setRunsFile(f);
  let t0 = Date.now(); const recent = G._internals.readRuns(); const tRecent = Date.now() - t0;
  assert.ok(recent.length > 0 && recent.length < 1200, 'only the last 72 h: ' + recent.length + ' rows');
  assert.ok(recent.every(r => r.endedAt >= now - 80 * 3600e3), 'every row is inside the window (+ slack)');
  t0 = Date.now(); const around = G._internals.runsFor(old.startedAt + 60e3); const tOld = Date.now() - t0;
  assert.ok(around.some(r => r.runId === 'run-ceo-old'), 'the old CEO run is found for an old clearance moment');
  assert.ok(tRecent < 1500 && tOld < 1500, 'bounded reads: window ' + tRecent + ' ms, seek ' + tOld + ' ms (a full parse of ' + Math.round(size / 1e6) + ' MB is the thing avoided)');
  t0 = Date.now(); G._internals.readRuns(); assert.ok(Date.now() - t0 < 50, 'cached while the file is unchanged');
  G._internals.setRunsFile(null);
  fs.unlinkSync(f);
});

test('competence: every anchor is still checked after decisions.md and the dispatch log rolled', () => {
  const C = require('../competence.js'); const R = require('../retention.js');
  const F = C.FILES;
  const rows = []; let prev = C.GENESIS;
  for (let i = 1; i <= 3; i++) { const r = { id: 'e' + i, kind: 'test', at: '2026-09-0' + i + 'T00:00:00Z', prev }; r.hash = C.rowHash(prev, r); prev = r.hash; rows.push(r); }
  W(path.relative(T, F.ledger), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const head = rows[2].hash;
  W(path.relative(T, F.decisions), '# Decisions\n\nNewest first.\n\n- 2026-11-16 09:00 Founder ruled something recent.\n\n'
    + '| 2026-09-10 03:00 | Competence ledger anchor: 3 events, head `' + head + '` (tamper-evident) | Dispatcher (competence.js daily) | `x` |\n');
  W(path.relative(T, F.dispatchLog), '# Dispatch log\n\n- 2026-09-10 03:00 COMPETENCE daily: +3 ledger rows, chain ok, anchored 3 rows, head ' + head + '\n- 2026-11-17 09:00 a recent line\n');
  const stateAnchors = [{ n: 3, head }];
  const v = (dec, log) => C.verifyLedger(rows, dec, { stateAnchors, logText: log });
  assert.ok(v(C.anchorText(F.decisions), C.anchorText(F.dispatchLog)).ok, 'before the roll');
  const all = JSON.parse(fs.readFileSync(DEFAULTS, 'utf8')).artifacts.filter(a => a.id === 'decisions' || a.id === 'dispatch-log');
  const res = R.apply({ root: T, home: path.join(T, '_home'), policy: { artifacts: all }, now: Date.parse('2026-11-17T12:00:00Z') });
  assert.ok(res.results.every(x => x.moved >= 1 && !x.error), JSON.stringify(res.results.map(x => ({ id: x.id, moved: x.moved, error: x.error }))));
  const live = fs.readFileSync(F.decisions, 'utf8');
  assert.ok(!live.includes(head) && live.includes('recent'), 'the anchor row rolled out of the live file');
  const after = v(C.anchorText(F.decisions), C.anchorText(F.dispatchLog));
  assert.ok(after.ok && after.anchors === 1 && after.logAnchors === 1, JSON.stringify(after));
  assert.ok(!v(fs.readFileSync(F.decisions, 'utf8'), fs.readFileSync(F.dispatchLog, 'utf8')).ok, 'the live file alone would report the state anchor as missing: the index is what keeps it checked');
  fs.unlinkSync(path.join(T, 'company/work/archive/decisions/index.md'));
  assert.ok(!v(C.anchorText(F.decisions), C.anchorText(F.dispatchLog)).ok, 'a removed index line is caught (the state file still names the anchor)');
});

test.after(() => { try { fs.rmSync(T, { recursive: true, force: true }); } catch (_) {} });
