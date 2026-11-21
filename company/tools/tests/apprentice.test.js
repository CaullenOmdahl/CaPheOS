#!/usr/bin/env node
/* apprentice.test.js — the apprentice's pieces (docs/APPRENTICE.md): the wire adapter, the direct client (scrub, host,
 * redirects, size cap), lessons (which items, transcripts written late, the read snapshot, facts, kind and depth, the
 * expected answer, the cut instructions, scoring with the bench's scorers), the promote gate, the shadow summary and the
 * schedule. The end-to-end run against a stub server is `node company/tools/apprentice.js --selftest`.
 *
 *   node --test company/tools/tests/apprentice.test.js
 */
'use strict';
process.env.CAPHEOS_TZ = 'UTC';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), http = require('http');
const life = require('../lib/temp-life');

const A = require('../lib/apprentice/adapter');
const C = require('../lib/apprentice/client');
const L = require('../lib/apprentice/lessons');
const AP = require('../apprentice.js');
const UNIT = path.join(__dirname, '..', '..', '..', 'packs', 'model-bench');
const CFG = { shadow: JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'defaults', 'state', 'apprentice.json'), 'utf8')).shadow };

function stub(handler) {
  return new Promise(resolve => {
    const reqs = [];
    const s = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { reqs.push({ url: req.url, body: b, headers: req.headers }); handler(req, res, b); }); });
    s.listen(0, '127.0.0.1', () => resolve({ s, reqs, url: 'http://127.0.0.1:' + s.address().port }));
  });
}

test('adapter: the chat body never offers tools and asks the server not to learn from bench calls', () => {
  const b = A.chatBody('ns/t', [{ role: 'user', content: 'hi' }, { role: 'tool', content: 'x' }], { purpose: 'bench' });
  for (const k of A.FORBIDDEN) assert.ok(!(k in b), k);
  assert.equal(b.stream, false); assert.equal(b.temperature, 0);
  assert.deepEqual(b.messages.map(m => m.role), ['user', 'user']);
  assert.equal(b.metadata.learn, false); assert.equal(b.metadata.purpose, 'bench');
});
test('adapter: tolerant readers (JSON, SSE, unit lists, study replies) and safe path ids', () => {
  assert.equal(A.chatReply({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 3 } }).text, 'ok');
  assert.equal(A.chatReply('data: {"choices":[{"delta":{"content":"he"}}]}\n\ndata: {"choices":[{"delta":{"content":"llo"}}]}\n\ndata: [DONE]\n').text, 'hello');
  assert.deepEqual(A.studyReply({ unit: { id: 'u1' }, state: 'Candidate' }), { unitId: 'u1', status: 'candidate' });
  const us = A.unitsReply({ data: [{ id: 'a', status: 'live' }, { unit_id: 'b', state: 'pending' }, { status: 'x' }] });
  assert.deepEqual(us.map(u => [u.id, u.live, u.candidate]), [['a', true, false], ['b', false, true]]);
  assert.throws(() => A.paths({ namespace: 'ns' }).promote('t', '../../x'), /unsafe/);
  assert.equal(A.paths({ namespace: 'ns' }).units('sandbox'), '/v1/ns/tenants/sandbox/units');
  assert.equal(A.candidateModel({ namespace: 'ns', tenant: 't' }, 'u9'), 'ns/t@u9');
  assert.equal(A.refusedSelfApproval(403), true);
});

test('client: every body is scrubbed, the key goes only in the header, a scrub failure sends nothing', async () => {
  const root = life.tmpDir('apprentice-client-');
  fs.mkdirSync(path.join(root, 'secrets')); fs.writeFileSync(path.join(root, 'secrets', 'thing'), 'value-of-a-company-secret-123\n');
  const st = await stub((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'echo value-of-a-company-secret-123' } }] })); });
  try {
    const c = C.makeClient({ root, cfg: { baseUrl: st.url, namespace: 'ns', tenant: 't' }, key: 'k-123' });
    const r = await c.chat('ns/t', [{ role: 'user', content: 'see value-of-a-company-secret-123 and ghp_' + 'a'.repeat(36) }]);
    assert.ok(!st.reqs[0].body.includes('value-of-a-company-secret-123'));
    assert.ok(!st.reqs[0].body.includes('ghp_' + 'a'.repeat(36)));
    assert.match(st.reqs[0].body, /\[REDACTED:/);
    assert.equal(st.reqs[0].headers.authorization, 'Bearer k-123');
    assert.ok(!r.text.includes('value-of-a-company-secret-123'), 'the reply is scrubbed too');
    let deep = { content: 'x' }; for (let i = 0; i < 40; i++) deep = { a: deep };
    const n = st.reqs.length;
    await assert.rejects(() => c.submitTrajectory({ task: deep }), /not sent/);
    assert.equal(st.reqs.length, n, 'nothing reached the server');
  } finally { st.s.close(); }
});
test('client: no redirects, a size cap, only http(s) to the configured host', async () => {
  const root = life.tmpDir('apprentice-client-');
  const st = await stub((req, res) => {
    if (req.url === '/healthz') { res.writeHead(302, { Location: 'http://example.invalid/' }); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ units: ['x'.repeat(5000)] }));
  });
  try {
    const c = C.makeClient({ root, cfg: { baseUrl: st.url, namespace: 'ns', tenant: 't', maxResponseBytes: 1000 } });
    await assert.rejects(() => c.health(), /redirect/);
    await assert.rejects(() => c.units(), /over 1000 bytes/);
    assert.throws(() => C.makeClient({ root, cfg: { baseUrl: 'file:///etc/passwd' } }), /http or https/);
    assert.throws(() => C.makeClient({ root, cfg: {} }), /no baseUrl/);
  } finally { st.s.close(); }
});

test('lessons: only settled, one-shot, unrevised items with a run are taken, oldest first', () => {
  const base = { excluded: false, settled: true, oneShot: 1, hard: true, runId: 'r', verdicts: [] };
  const items = [
    Object.assign({}, base, { key: 'ok2', closedAt: 2 }), Object.assign({}, base, { key: 'ok1', closedAt: 1 }),
    Object.assign({}, base, { key: 'revise', oneShot: 0 }), Object.assign({}, base, { key: 'reopened', hard: false }),
    Object.assign({}, base, { key: 'young', settled: false }), Object.assign({}, base, { key: 'norun', runId: null }),
    Object.assign({}, base, { key: 'excl', excluded: true }), Object.assign({}, base, { key: 'done' }),
  ];
  const r = L.eligible(items, CFG, { done: { at: 1 } });
  assert.deepEqual(r.take.map(i => i.key), ['ok1', 'ok2']);
  assert.deepEqual(r.skipped, { 'not-one-shot': 1, 'reopened-or-reverted': 1, settling: 1, 'no-run': 1, excluded: 1, done: 1 });
  const strict = L.eligible(items, { shadow: { requirePassVerdict: true } }, {});
  assert.equal(strict.take.length, 0);
});

test('lessons: a transcript not written yet waits, then is dropped as no-transcript; never a failure', () => {
  const root = life.tmpDir('apprentice-tr-');
  const dir = path.join(root, '.starnet-data', 'workspaces', 'transcript-history-v2'); fs.mkdirSync(dir, { recursive: true });
  const run = { runId: 'run-1', streamId: 'cron-run-1', startedAt: 1000, endedAt: 5000 };
  fs.writeFileSync(path.join(dir, 'segment-000001.index.json'), JSON.stringify({ minTs: 0, maxTs: 4000, streams: {} }));
  fs.writeFileSync(path.join(dir, 'segment-000001.jsonl'), '');
  assert.equal(L.transcript(root, run, CFG, 6000).state, 'waiting');
  assert.equal(L.transcript(root, run, CFG, 5000 + 4 * 864e5).state, 'none');
  // the segment that lists the run's stream is read; another segment in the same time range is not
  fs.writeFileSync(path.join(dir, 'segment-000002.index.json'), JSON.stringify({ minTs: 900, maxTs: 9000, streams: { 'cron-run-1': { count: 2 } } }));
  fs.writeFileSync(path.join(dir, 'segment-000002.jsonl'), [{ role: 'assistant', sourceRunId: 'run-1', ts: 1100, content: 'A' }, { role: 'assistant', sourceRunId: 'run-2', ts: 1200, content: 'B' }].map(x => JSON.stringify(x)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'segment-000003.index.json'), JSON.stringify({ minTs: 900, maxTs: 9000, streams: { other: {} } }));
  fs.writeFileSync(path.join(dir, 'segment-000003.jsonl'), JSON.stringify({ role: 'assistant', sourceRunId: 'run-1', ts: 1300, content: 'C' }) + '\n');
  const t = L.transcript(root, run, CFG, 6000);
  assert.equal(t.state, 'ok'); assert.deepEqual(t.rows.map(r => r.content), ['A']);
});

test('lessons: the teacher is the last message without tool calls; reads are the read tools and read-only shell', () => {
  const tc = (id, name, args) => JSON.stringify([{ id, function: { name, arguments: JSON.stringify(args) } }]);
  const rows = [
    { role: 'assistant', sourceRunId: 'r', ts: 1, content: 'looking', toolCalls: tc('a', 'fs_read', { path: 'notes/a.md' }) },
    { role: 'tool', sourceRunId: 'r', ts: 2, toolCallId: 'a', content: 'Rate: 85 EUR' },
    { role: 'assistant', sourceRunId: 'r', ts: 3, content: '', toolCalls: tc('b', 'shell_exec', { command: 'grep -n rate notes/b.md | head -5' }) },
    { role: 'tool', sourceRunId: 'r', ts: 4, toolCallId: 'b', content: '3: rate 90' },
    { role: 'assistant', sourceRunId: 'r', ts: 5, content: '', toolCalls: tc('c', 'shell_exec', { command: 'cat a > b' }) },
    { role: 'tool', sourceRunId: 'r', ts: 6, toolCallId: 'c', content: 'nothing' },
    { role: 'assistant', sourceRunId: 'r', ts: 7, content: '', toolCalls: tc('d', 'fs_write', { path: 'x' }) },
    { role: 'tool', sourceRunId: 'r', ts: 8, toolCallId: 'd', content: 'written' },
    { role: 'assistant', sourceRunId: 'r', ts: 9, content: [{ type: 'text', text: 'Rate: 85 EUR' }] },
  ];
  const r = L.teacherAndReads(rows, 'r', CFG);
  assert.equal(r.teacher, 'Rate: 85 EUR');
  assert.deepEqual(Object.keys(r.files), ['notes/a.md', '$ grep -n rate notes/b.md | head -5']);
  assert.equal(L.readOnlyShell('sed -n 1,5p a.md'), true);
  for (const bad of ['sed -i s/a/b/ f', 'cat a; rm b', 'ls $(pwd)', 'curl http://x', 'cat a && rm b', 'head `x`']) assert.equal(L.readOnlyShell(bad), false, bad);
  const capped = L.teacherAndReads([rows[0], Object.assign({}, rows[1], { content: 'x'.repeat(50000) })], 'r', CFG);
  assert.ok(Buffer.byteLength(capped.files['notes/a.md']) <= CFG.shadow.maxFileBytes + 10);
});

test('lessons: facts from labelled lines, bold labels, two-column tables and dash bullets', () => {
  const f = L.facts([
    'Here is what I found.', '**Client:** Northwind Ltd', 'Contract start: 2026-03-01', '- Rate — 85 EUR',
    '| Field | Value |', '|---|---|', '| Owner | Dana Ruiz |', '**Status:** DONE', 'Next steps: none', '```', 'code: x', '```',
  ].join('\n'), CFG);
  assert.deepEqual(f.map(x => [x.label, x.value]), [['Client', 'Northwind Ltd'], ['Contract start', '2026-03-01'], ['Rate', '85 EUR'], ['Owner', 'Dana Ruiz']]);
  assert.deepEqual(L.numeric('€1,200.50'), { n: 1200.5, unit: 'EUR', currency: true });
  assert.equal(L.numeric('Northwind'), null);
});

test('lessons: kind and depth: Kind/Depth lines, then route.scoped, then the class map; numbers move to kind 5', () => {
  const it = cls => ({ cell: { class: cls } });
  const facts = [{ label: 'A', value: 'x' }, { label: 'B', value: 'y' }];
  assert.deepEqual(L.kindDepth({ item: it('research'), sec: '', cfg: CFG, facts }), { kind: 1, depth: 'lookup', why: 'class research' });
  assert.equal(L.kindDepth({ item: it('code'), sec: '', cfg: CFG, facts }).skip, 'kind-out-of-scope');
  assert.equal(L.kindDepth({ item: it('general'), sec: '', cfg: CFG, facts }).skip, 'kind-out-of-scope');
  assert.deepEqual(L.kindDepth({ item: it('code'), sec: '**Kind:** 2\n**Depth:** simple', cfg: CFG, facts }), { kind: 2, depth: 'simple', why: 'kind line' });
  assert.equal(L.kindDepth({ item: it('code'), sec: '', wake: { route: { scoped: { kind: 2, depth: 'lookup' } } }, cfg: CFG, facts }).kind, 2);
  assert.equal(L.kindDepth({ item: it('mechanical'), sec: '**Depth:** deep', cfg: CFG, facts }).depth, 'simple', 'mechanical is capped at simple');
  const nums = [{ label: 'Total', value: '1,200 EUR' }, { label: 'Tax', value: '€240' }];
  assert.equal(L.kindDepth({ item: it('research'), sec: '', cfg: CFG, facts: nums }).kind, 5);
  const res = { item: it('research'), sec: '**Depth:** simple', cfg: CFG };
  assert.equal(L.kindDepth(Object.assign({ facts: [facts[0]] }, res)).kind, 1, 'kind 2 with one fact is a lookup');
  assert.equal(L.kindDepth(Object.assign({ facts }, res)).kind, 2);
});

test('lessons: the expected answer per kind, and the instructions never carry the answer', async () => {
  const fs_ = [{ label: 'Client', value: 'Northwind Ltd' }, { label: 'Total', value: '1,200.50 EUR' }, { label: 'Start', value: '2026-03-01' }];
  assert.deepEqual(L.toExpected(1, fs_).ask.map(a => a.id), ['q1', 'q2', 'q3']);
  const k2 = L.toExpected(2, fs_);
  assert.deepEqual(k2.expected.types, { total: 'money', start: 'date' });
  const k5 = L.toExpected(5, fs_);
  assert.deepEqual(k5.expected, { values: { total: 1200.5 }, unit: 'EUR', precision: 2 });
  const ins = L.instructions('## 2026-01-01 from Lee — client facts\n**Need:** the client and the total\n(we think Northwind Ltd)\n**Status:** DONE\n**Resolved 2026-01-02 by Sam** Client: Northwind Ltd', fs_);
  assert.ok(!/Northwind/.test(ins.text) && !/Resolved/.test(ins.text) && /\*\*Need:\*\*/.test(ins.text));
  assert.equal(ins.dropped, 1);
  const p = L.promptFor(UNIT, 1, ins.text, L.toExpected(1, fs_).ask, { 'notes/a.md': 'Client: Northwind Ltd' });
  assert.match(p, /- q1: Client/); assert.match(p, /=== file: notes\/a\.md ===/); assert.match(p, /Answer in one message/);
  assert.ok(!/bench-canary/.test(p));
  // the bench's own scorers
  const ok = await L.score(UNIT, 1, '```json\n{"answers":[{"id":"q1","value":"northwind ltd"},{"id":"q2","value":"1200.50"},{"id":"q3","value":"1 March 2026"}]}\n```', L.toExpected(1, fs_).expected);
  assert.equal(ok.pass, true);
  const bad = await L.score(UNIT, 5, 'no json here', k5.expected);
  assert.equal(bad.failure, 'unparseable');
  const k5ok = await L.score(UNIT, 5, '```json\n{"values":{"total":1200.5},"unit":"EUR"}\n```', k5.expected);
  assert.equal(k5ok.pass, true);
});

test('promote gate: a gain with no level worse promotes; a level worse or no gain rolls back', () => {
  const res = lv => ({ kinds: Object.fromEntries(Object.entries(lv).map(([k, ds]) => [k, { levels: Object.fromEntries(Object.entries(ds).map(([d, p]) => [d, { passed: p, instances: 12 }])) }])) });
  const live = res({ 1: { lookup: 10, simple: 8 }, 5: { lookup: 4, simple: 2 } });
  assert.equal(AP.promoteGate(live, res({ 1: { lookup: 11, simple: 8 }, 5: { lookup: 4, simple: 3 } }), 0).promote, true);
  const mixed = AP.promoteGate(live, res({ 1: { lookup: 12, simple: 7 }, 5: { lookup: 9, simple: 2 } }), 0);
  assert.equal(mixed.promote, false); assert.match(mixed.reason, /worse at 1 simple 8 -> 7/);
  assert.equal(AP.promoteGate(live, res({ 1: { lookup: 12, simple: 7 }, 5: { lookup: 9, simple: 2 } }), 1).promote, true, 'within tolerance');
  assert.match(AP.promoteGate(live, live, 0).reason, /no gain/);
  assert.match(AP.promoteGate(live, res({ 1: { lookup: 12, simple: null }, 5: { lookup: 12, simple: 12 } }), 5).reason, /not proven/);
});

test('shadow summary: per kind and depth, marked shadow, in the shape a capability table reads; skipped by a model-bench/1 filter', () => {
  const rows = [{ outcome: 'scored', kind: 1, depth: 'lookup', pass: true, score: 1, timeSec: 2 }, { outcome: 'scored', kind: 1, depth: 'lookup', pass: false, score: 0.5, timeSec: 4 },
    { outcome: 'skipped', reason: 'no-transcript' }, { outcome: 'scored', kind: 5, depth: 'simple', pass: true, score: 1, timeSec: 3 }];
  const s = AP.shadowSummary(rows, 'apprentice/ns/t');
  assert.equal(s.schema, 'model-bench-shadow/1'); assert.equal(s.source, 'shadow'); assert.equal(s.routable, false);
  assert.deepEqual(s.kinds['1'].levels.lookup, { n: 2, passed: 1, passRate: 0.5, scoreMean: 0.75, timeSecP50: 2 });
  assert.deepEqual(s.live, [{ model: 'apprentice/ns/t', kind: 1, depth: 'lookup', n: 2, oneShot: 1, timeSecP50: 2 }, { model: 'apprentice/ns/t', kind: 5, depth: 'simple', n: 1, oneShot: 1, timeSecP50: 3 }]);
  assert.notEqual(s.schema, 'model-bench/1');
});

test('schedule: study only in the quiet hours and once a day; shadow every everyMin under the daily cap', () => {
  const cfg = { shadow: { everyMin: 60, dailyCap: 2 }, study: { hourLocal: 3, quietHours: 3, everyHours: 24 } };
  const at = h => Date.UTC(2030, 0, 10, h, 0, 0);
  const st = { days: {}, lastShadowAt: 0, lastStudyAt: 0 };
  assert.equal(AP.studyDue(cfg, st, at(2)), false); assert.equal(AP.studyDue(cfg, st, at(4)), true); assert.equal(AP.studyDue(cfg, st, at(6)), false);
  assert.equal(AP.studyDue(cfg, Object.assign({}, st, { lastStudyAt: at(3) }), at(5)), false);
  assert.equal(AP.shadowDue(cfg, st, at(9)), true);
  assert.equal(AP.shadowDue(cfg, Object.assign({}, st, { lastShadowAt: at(9) - 30 * 60e3 }), at(9)), false);
  assert.equal(AP.shadowDue(cfg, Object.assign({}, st, { days: { '2030-01-10': { shadowed: 2 } } }), at(9)), false);
});

test('off by default: the shipped defaults never turn it on, and due() is false with no owner file', () => {
  const root = life.tmpDir('apprentice-off-');
  fs.mkdirSync(path.join(root, 'company', 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, 'company', 'state', 'apprentice.json'), JSON.stringify({ enabled: true, baseUrl: 'http://127.0.0.1:1' }));
  assert.equal(AP.config(root).enabled, false, 'a file without the owner\'s recorded write is off');
  assert.equal(AP.due({ root, isSandbox: () => true }), false);
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'defaults', 'state', 'apprentice.json'), 'utf8'));
  assert.equal(d.baseUrl, null); assert.ok(!('enabled' in d) || d.enabled === false);
  assert.deepEqual(d.routable, { 'apprentice/*': false });
});

test('lessons: delegated items are skipped; a scope skip is looked at again when the shadow scope changes', () => {
  const base = { excluded: false, settled: true, oneShot: 1, hard: true, runId: 'r', verdicts: [] };
  const items = [Object.assign({}, base, { key: 'del', delegated: true }), Object.assign({}, base, { key: 'oos' }), Object.assign({}, base, { key: 'scored' })];
  const done = { oos: { at: 1, outcome: 'kind-out-of-scope', scope: 'A' }, scored: { at: 1, outcome: 'scored', scope: 'A' } };
  assert.deepEqual(L.eligible(items, CFG, done, 'A').take.map(i => i.key), []);
  assert.equal(L.eligible(items, CFG, done, 'A').skipped.delegated, 1);
  assert.deepEqual(L.eligible(items, CFG, done, 'B').take.map(i => i.key), ['oos'], 'a new scope re-opens the scope skip, never a scored item');
  assert.deepEqual(L.teacherRuns({ runId: 'r1', ownRuns: ['r1', 'r2'], lastRunId: 'r2' }), { teacherRunId: 'r2', runIds: ['r1', 'r2'] });
  assert.deepEqual(L.teacherRuns({ runId: 'r1' }), { teacherRunId: 'r1', runIds: ['r1'] });
});

test('lessons: with several runs the teacher is the last run\'s answer and the reads come from all of them', () => {
  const tc = (id, args) => JSON.stringify([{ id, function: { name: 'fs_read', arguments: JSON.stringify(args) } }]);
  const rows = [
    { role: 'assistant', sourceRunId: 'r1', ts: 1, content: '', toolCalls: tc('a', { path: 'a.md' }) },
    { role: 'tool', sourceRunId: 'r1', ts: 2, toolCallId: 'a', content: 'Client: Northwind Ltd' },
    { role: 'assistant', sourceRunId: 'r1', ts: 3, content: 'Halfway. **Client:** unknown yet' },
    { role: 'assistant', sourceRunId: 'r2', ts: 4, content: '**Client:** Northwind Ltd' },
  ];
  const r = L.teacherAndReads(rows, ['r1', 'r2'], CFG, 'r2');
  assert.equal(r.teacher, '**Client:** Northwind Ltd');
  assert.deepEqual(Object.keys(r.files), ['a.md']);
});

test('lessons: covered segments with no row of the run yet wait (written late), then none after maxWaitDays', () => {
  const root = life.tmpDir('apprentice-tr2-');
  const dir = path.join(root, '.starnet-data', 'workspaces', 'transcript-history-v2'); fs.mkdirSync(dir, { recursive: true });
  const run = { runId: 'run-9', startedAt: 1000, endedAt: 5000 };
  fs.writeFileSync(path.join(dir, 'segment-000001.index.json'), JSON.stringify({ minTs: 0, maxTs: 9000, streams: {} }));
  fs.writeFileSync(path.join(dir, 'segment-000001.jsonl'), JSON.stringify({ role: 'assistant', sourceRunId: 'other', ts: 1100, content: 'x' }) + '\n');
  assert.equal(L.transcript(root, run, CFG, 6000).state, 'waiting');
  assert.equal(L.transcript(root, run, CFG, 5000 + 4 * 864e5).state, 'none');
});

test('lessons: only facts whose value is in what the run read are kept; denied paths are never read', () => {
  const g = L.grounded([{ label: 'Client', value: 'Northwind Ltd' }, { label: 'Total', value: '1,200 EUR' }, { label: 'Blocked', value: 'five items, none on me' }, { label: 'N', value: '3' }],
    { 'a.md': 'client **Northwind** Ltd owes 1200 EUR across 13 lines' });
  assert.deepEqual(g.keep.map(f => f.label), ['Client', 'Total']);
  assert.deepEqual(g.dropped.map(f => f.label), ['Blocked', 'N'], 'a status line and a digit inside another number are not grounded');
  const deny = L.denier();
  for (const p of ['secrets/slaingi-key', '.env', 'app/.env.local', 'certs/server.pem', '/home/u/.ssh/id_ed25519', '$ cat secrets/x', '$ grep -r token .env']) assert.equal(deny(p), true, p);
  for (const p of ['clients/northwind.md', '$ grep -n rate notes/b.md', 'src/env.js']) assert.equal(deny(p), false, p);
});

test('lessons: the lesson target is the right answer in the bench answer shape', () => {
  const fs_ = [{ label: 'Client', value: 'Northwind Ltd' }, { label: 'Total', value: '1,200.50 EUR' }];
  const parse = t => JSON.parse(t.replace(/^```json\n|\n```$/g, ''));
  assert.deepEqual(parse(L.target(1, L.toExpected(1, fs_).expected)), { answers: [{ id: 'q1', value: 'Northwind Ltd' }, { id: 'q2', value: '1,200.50 EUR' }] });
  assert.deepEqual(parse(L.target(5, L.toExpected(5, fs_).expected)), { values: { total: 1200.5 }, unit: 'EUR' });
  const body = A.trajectoryBody({ task: { prompt: 'P' }, teacher: { answer: 'prose', target: '```json\n{}\n```' } });
  assert.equal(body.trajectories[0].messages[1].content, '```json\n{}\n```');
});

test('promote gate: a server fault in either bench decides nothing', () => {
  const res = (p, f) => ({ kinds: { 1: { levels: { lookup: { passed: p, instances: 12, failures: Object.assign({ timeout: 0, unparseable: 0, crash: 0, refused: 0, sandbox: 0 }, f || {}) } } } } });
  const g = AP.promoteGate(res(0, { crash: 12 }), res(1), 0);
  assert.equal(g.promote, false); assert.equal(g.incomplete, true);
  assert.equal(AP.promoteGate(res(5), res(9, { timeout: 1 }), 0).incomplete, true);
  assert.equal(AP.promoteGate(res(5, { unparseable: 3 }), res(9), 0).promote, true, 'an unparseable answer is the model\'s fault, not the server\'s');
});

test('client: a hard total deadline cuts off a server that trickles bytes; an HTTP error keeps only its status', async () => {
  const root = life.tmpDir('apprentice-client-');
  const st = await stub((req, res) => {
    if (req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json' }); const t = setInterval(() => res.write(' '), 200); res.on('close', () => clearInterval(t)); return; }
    res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'SERVER-WORDS here' }));
  });
  try {
    const c = C.makeClient({ root, cfg: { baseUrl: st.url, namespace: 'ns', tenant: 't', requestTimeoutSec: 1 } });
    const t0 = Date.now();
    await assert.rejects(() => c.health(), /timed out/);
    assert.ok(Date.now() - t0 < 2500, 'cut at the deadline, not kept alive by the trickle');
    const t1 = Date.now();
    await assert.rejects(() => c.units({ deadline: Date.now() - 1 }), /deadline has passed/);
    assert.ok(Date.now() - t1 < 500);
    await assert.rejects(() => c.chat('ns/t', [{ role: 'user', content: 'x' }]), e => /HTTP 500$/.test(e.message) && !/SERVER-WORDS/.test(e.message));
  } finally { st.s.closeAllConnections && st.s.closeAllConnections(); st.s.close(); }
});

test('lock: a live apprentice holder in budget is never taken over; past its budget it is ended; an ended holder\'s lock is free', async () => {
  const { spawn } = require('child_process');
  const root = life.tmpDir('apprentice-lock-');
  const f = path.join(root, 'company', 'state', 'apprentice', 'lock'); fs.mkdirSync(path.dirname(f), { recursive: true });
  const kid = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', 'apprentice.js'], { stdio: 'ignore' });
  const gone = new Promise(r => kid.on('exit', r));
  try {
    fs.writeFileSync(f, JSON.stringify({ pid: kid.pid, until: Date.now() + 60e3, token: 'x' }));
    assert.equal(AP.lockState(root).state, 'held');
    assert.equal(AP.takeLock(root, 1000), null, 'a live holder in budget keeps its lock');
    if (fs.existsSync('/proc/' + kid.pid + '/cmdline')) {
      // a live process that is not an apprentice pass (the pid was reused) does not hold it
      fs.writeFileSync(f, JSON.stringify({ pid: process.pid, until: Date.now() + 60e3, token: 'z' }));
      assert.equal(AP.lockState(root).state, 'free');
      fs.writeFileSync(f, JSON.stringify({ pid: kid.pid, until: Date.now() - 3600e3, token: 'x' }));
      assert.equal(AP.lockState(root).state, 'overdue');
      const rel = AP.takeLock(root, 1000);
      assert.ok(rel, 'an overdue pass is ended and its lock taken');
      await gone; rel();
    }
  } finally { try { kid.kill('SIGKILL'); } catch (_) {} }
  fs.writeFileSync(f, JSON.stringify({ pid: 2 ** 22 + 12345, until: Date.now() + 60e3, token: 'y' }));
  assert.equal(AP.lockState(root).state, 'free');
  const rel = AP.takeLock(root, 1000); assert.ok(rel); assert.equal(AP.lockState(root).state, 'held'); rel(); assert.equal(fs.existsSync(f), false);
});
