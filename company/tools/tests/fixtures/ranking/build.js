#!/usr/bin/env node
/* build.js — writes the golden fixture for company/tools/model-rank.js into ./root (invented crew: Lee, Sam, Kim, Ria).
 *
 *   node company/tools/tests/fixtures/ranking/build.js            rewrite root/ and now.json
 *   node company/tools/tests/fixtures/ranking/build.js --expected also rewrite expected-house-ranking.json from a fresh
 *                                                                   refresh (only after checking the new numbers by hand)
 *
 * What is in it (docs/RANKING.md):
 *   S01-S24  Sam, code, claude-cli/claude-sonnet-5-5 @ high, servedModel confirmed: S03 got a REVISE from a peer (fails),
 *            S05 was reopened two days after it closed, S07 failed premerge once before passing, S08 passed first time
 *   S25      Sam, closed two days before "now": still settling, not scored
 *   F01-F22  Kim, code, claude-cli/claude-fable-5-2[1m] @ medium, no servedModel (claimed); this is the department's
 *            route. F02: REVISE by the lead (counts half). F04: REVISE by Kim herself (ignored). F06: REVISE with no cited
 *            check (ignored). F08: a confirmed S1 defect. F10: a second run (rework). F12: a delegated child cut by the
 *            dispatch slice (excluded, not a failure). F14: the lead approves it in a consult block.
 *   O01-O05  Kim, code, requested claude-fable-5-2[1m], the provider served claude-opus-4-8: its own cell, not enough data
 *   X01      Kim: the only run is a provider error -> the item is excluded
 *   M01-M03  Sam, Effort: mechanical, deepseek/deepseek-flash @ high, metered usd
 */
'use strict';
const fs = require('fs'), path = require('path');
const HERE = __dirname, ROOT = path.join(HERE, 'root');
const NOW = Date.UTC(2030, 1, 1, 0, 0, 0);
const H = 3600e3, D = 24 * H;
const day = n => Date.UTC(2030, 0, n);
const ymd = ms => new Date(ms).toISOString().slice(0, 10);
const hm = ms => new Date(ms).toISOString().slice(11, 16);

fs.rmSync(ROOT, { recursive: true, force: true });
const w = (rel, data) => { const f = path.join(ROOT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1) + '\n'); };

// the policy the golden file was computed with (a snapshot: tuning the shipped default does not move the golden file)
w('company/work/models/ranking-policy.json', fs.readFileSync(path.join(HERE, '..', '..', '..', '..', 'defaults', 'work', 'models', 'ranking-policy.json'), 'utf8'));
w('company/company.json', { name: 'Fixture Co', timezone: 'UTC', owner: { name: 'Owner' } });
w('company/tools/loops.json', { agents: {
  lee: { name: 'Lee', functions: ['ceo', 'people', 'tools', 'risk', 'floor', 'finance'], inbox: 'to-lee.md', manager: null },
  sam: { name: 'Sam', inbox: 'to-sam.md', manager: 'lee' },
  kim: { name: 'Kim', inbox: 'to-kim.md', manager: 'lee' },
  ria: { name: 'Ria', inbox: 'to-ria.md', manager: 'lee' },
} });
w('company/departments.json', { _doc: 'fixture', leadModelDefault: { provider: 'claude-cli', model: 'claude-opus-5-5', effort: 'medium' }, departments: [
  { id: 'eng', name: 'Engineering', lead: 'lee', members: ['sam', 'kim', 'ria'], defaultClass: 'code', brief: 'company/work/departments/eng/BRIEF.md',
    routes: { code: { provider: 'claude-cli', model: 'claude-fable-5-2[1m]', effort: 'medium' } }, consult: { maxPerDay: 12, stuckAfterFailedRuns: 2, stuckAfterRevise: 2, stuckAfterIdleWakes: 2 } },
] });

const inbox = { 'to-sam.md': ['# Sam inbox\n'], 'to-kim.md': ['# Kim inbox\n'], 'to-lee.md': ['# Lee inbox\n'] };
const wakes = [], runs = [], ledger = [];
let seq = 0;
const rid = tag => 'run-' + tag + '-' + String(++seq).padStart(4, '0');
function block(file, o) {
  const lines = ['## ' + ymd(o.opened) + ' ' + hm(o.opened) + ' from Lee — ' + o.title, '**Id:** ' + o.id, '**Need:** ' + o.title];
  if (o.effort) lines.push('**Effort:** ' + o.effort);
  if (o.pr) lines.push('**PR:** ' + o.pr);
  for (const v of o.verdicts || []) lines.push('**Verdict:** ' + v);
  lines.push('**Status:** DONE', '**Resolved ' + ymd(o.closed) + ' ' + hm(o.closed) + ' by ' + o.by + '**');
  inbox[file].push(lines.join('\n') + '\n');
}
function run(o) {
  const r = { runId: o.runId, parentRunId: o.parent || '', agentId: o.agent, provider: o.provider, model: o.model, reasoningEffort: o.effort, reason: o.reason || 'done',
    turns: 10, tokens: o.tokens, cachedTokens: o.cached, usd: o.usd || 0, unmetered: o.unmetered !== false, startedAt: o.start, endedAt: o.start + 30 * 60e3, ts: o.start + 30 * 60e3 };
  if (o.served) r.servedModel = o.served;
  runs.push(r); return r;
}
function wake(seat, at, runId, file, ids) { wakes.push({ at, ts: new Date(at).toISOString(), wakeId: 'wk-' + String(wakes.length + 1).padStart(4, '0'), seat, runId, door: 'dispatch', items: ids.map(id => ({ file, id, title: 'task ' + id, due: null })), why: 'handoff' }); }

const SONNET = { provider: 'claude-cli', model: 'claude-sonnet-5-5', served: 'claude-sonnet-5-5', effort: 'high', tokens: 400000, cached: 360000 };
const FABLE = { provider: 'claude-cli', model: 'claude-fable-5-2[1m]', effort: 'medium', tokens: 600000, cached: 500000 };
const OPUS48 = { provider: 'claude-cli', model: 'claude-fable-5-2[1m]', served: 'claude-opus-4-8', effort: 'medium', tokens: 500000, cached: 420000 };
const FLASH = { provider: 'deepseek', model: 'deepseek-flash', effort: 'high', tokens: 300000, cached: 250000, usd: 0.02, unmetered: false };

function item(file, seat, id, d, spec, extra) {
  extra = extra || {};
  const opened = day(d) + 9 * H, at = day(d) + 10 * H, closed = extra.closed || day(d) + 15 * H;
  const r = run(Object.assign({}, spec, { runId: rid(id), agent: seat, start: at + 60e3, reason: extra.reason }));
  wake(seat, at, r.runId, file, [id]);
  block(file, Object.assign({ id, title: 'task ' + id, opened, closed, by: seat === 'sam' ? 'Sam' : 'Kim' }, extra));
  return r;
}

for (let i = 1; i <= 24; i++) {
  const id = 'S' + String(i).padStart(2, '0'), d = 2 + (i % 20);
  const extra = {};
  if (i === 3) extra.verdicts = ['REVISE by Ria — check: the parser test suite fails on empty input — 2 findings'];
  if (i === 7) extra.pr = 'acme/web#12';
  if (i === 8) extra.pr = 'acme/web#13';
  item('to-sam.md', 'sam', id, d, SONNET, extra);
  if (i === 5) { const r = run(Object.assign({}, SONNET, { runId: rid('S05-reopen'), agent: 'sam', start: day(d) + 2 * D + 10 * H })); wake('sam', day(d) + 2 * D + 10 * H - 60e3, r.runId, 'to-sam.md', ['S05']); }
}
item('to-sam.md', 'sam', 'S25', 30, SONNET);   // closed 2030-01-30: settling

for (let i = 1; i <= 22; i++) {
  const id = 'F' + String(i).padStart(2, '0'), d = 2 + (i % 20);
  const extra = {};
  if (i === 2) extra.verdicts = ['REVISE by Lee — check: acceptance step 3 (the export) fails — one finding'];
  if (i === 4) extra.verdicts = ['REVISE by Kim — check: my own rerun failed'];
  if (i === 6) extra.verdicts = ['REVISE by Ria — looks wrong to me'];
  const r = item('to-kim.md', 'kim', id, d, FABLE, extra);
  if (i === 8) {
    ledger.push({ schema: 1, kind: 'credit', id: 'ev-credit-f08', signal: 'work.reviewed', agent: 'kim', bucket: 'build', at: new Date(day(d) + 16 * H).toISOString(), authorCorroboratedBy: r.runId });
    ledger.push({ schema: 1, kind: 'demerit', id: 'ev-defect-f08', signal: 'defect.confirmed', agent: 'kim', bucket: 'build', at: new Date(day(d) + 3 * D).toISOString(), severity: 'S1', reach: 'R2', caught: 'after', links: { parent: 'ev-credit-f08' } });
  }
  if (i === 10) { const r2 = run(Object.assign({}, FABLE, { runId: rid('F10-again'), agent: 'kim', start: day(d) + 12 * H })); wake('kim', day(d) + 12 * H - 60e3, r2.runId, 'to-kim.md', ['F10']); }
  if (i === 12) {
    const c = run(Object.assign({}, SONNET, { runId: rid('F12-child'), parent: r.runId, agent: 'sam', start: r.startedAt + 5 * 60e3, reason: 'cancelled' }));
    runs.push({ runId: c.runId, kind: 'dispatch-delivery', ts: c.endedAt, dispatchDelivery: { reason: 'timeout' } });
  }
  if (i === 14) inbox['to-lee.md'].push('## ' + ymd(day(d) + 14 * H) + ' 14:00 from Kim — consult on F14\n**Item:** F14\n**Verdict:** APPROVE by Lee — check: ran the acceptance steps 1-4, all pass\n**Status:** DONE\n');
}
for (let i = 1; i <= 5; i++) item('to-kim.md', 'kim', 'O' + String(i).padStart(2, '0'), 3 + i, OPUS48);
item('to-kim.md', 'kim', 'X01', 11, FABLE, { reason: 'error' });
for (let i = 1; i <= 3; i++) item('to-sam.md', 'sam', 'M' + String(i).padStart(2, '0'), 4 + i, FLASH, { effort: 'mechanical' });

w('company/work/evidence/premerge-web-aaaa1111.json', { v: 1, tool: 'company/tools/premerge-check.js', repo: 'acme/web', pr: 12, sha: 'aaaa1111', verdict: 'PASS', at: '2030-01-09T14:00:00.000Z', history: [{ verdict: 'FAIL', at: '2030-01-09T12:00:00.000Z' }] });
w('company/work/evidence/premerge-web-bbbb2222.json', { v: 1, tool: 'company/tools/premerge-check.js', repo: 'acme/web', pr: 13, sha: 'bbbb2222', verdict: 'PASS', at: '2030-01-10T14:00:00.000Z', history: [] });

wakes.sort((a, b) => a.at - b.at); runs.sort((a, b) => (a.ts - b.ts) || (a.runId < b.runId ? -1 : 1));
for (const [f, parts] of Object.entries(inbox)) w('company/work/handoffs/' + f, parts.join('\n'));
w('company/state/wakes.jsonl', wakes.map(x => JSON.stringify(x)).join('\n') + '\n');
w('.starnet-data/workspaces/runs.jsonl', runs.map(x => JSON.stringify(x)).join('\n') + '\n');
w('company/work/people/competence-events.jsonl', ledger.map(x => JSON.stringify(x)).join('\n') + '\n');
fs.writeFileSync(path.join(HERE, 'now.json'), JSON.stringify({ now: NOW, iso: new Date(NOW).toISOString() }) + '\n');

if (process.argv.includes('--expected')) {
  const os = require('os'); const { spawnSync } = require('child_process');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'rank-build-'));
  fs.cpSync(ROOT, T, { recursive: true });
  const r = spawnSync(process.execPath, [path.join(HERE, '..', '..', '..', 'model-rank.js'), 'refresh', '--force', '--now', String(NOW)], { encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: T, CAPHEOS_TZ: 'UTC' }) });
  if (r.status !== 0) { console.error(r.stdout + r.stderr); process.exit(1); }
  fs.copyFileSync(path.join(T, 'company', 'work', 'models', 'house-ranking.json'), path.join(HERE, 'expected-house-ranking.json'));
  fs.rmSync(T, { recursive: true, force: true });
  console.log('wrote expected-house-ranking.json');
}
console.log('fixture written: ' + wakes.length + ' wakes, ' + runs.length + ' run rows, ' + ledger.length + ' ledger rows');
