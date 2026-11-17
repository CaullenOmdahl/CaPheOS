#!/usr/bin/env node
/* pm-inbox-guard.test.js — company/pm-inbox.jsonl holds the owner's questions and answers; an answer, close or snooze is the
 * owner's word, a withdraw or reclassify the asker's (company/tools/lib/pm-inbox-guard.js). Real processes, a throwaway
 * company:
 *   - history before the cutover is readable (the question shows answered) but its answer never counts as a gate answer;
 *   - a forged answer / close row from an agent's run (a child with the station's environment pins), three ways, is ignored
 *     by every reader (inbox state and open questions, which Today, the dispatcher and approvals read; governance answerOf
 *     and approved), logged and raised to risk once, and the locked-file watch strips it into quarantine;
 *   - a withdraw of another seat's question is refused (the wrong --from, a claim the transcript or the station's agent id
 *     contradicts), and a hand-appended one is ignored; the asker's own withdraw still works and is trusted;
 *   - the console answer (Today), Today itself, a snooze, an approval answered in chat, all still work and are trusted.
 * Nothing here reaches a station (STARNET_URL is a closed port) or the checkout.
 *
 *   node --test company/tools/tests/pm-inbox-guard.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const UNDER_STATION = (() => { try { return require(path.join(REPO, 'company', 'tools', 'provenance.js')).underStation(); } catch (_) { return false; } })();
const STATION_PINS = { STARNET_USER_CONTROL_MODE: 'preserve', STARNET_COMPUTER_DRIVER: '0', STARNET_MCP_STDIO: '0', BROWSER: 'none' };
const QID = 'q-000123';     // a gate question Sam asked before this change, answered "yes" then (history)
const QOLD = 'q-000124';    // an open question from before the change

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-inbox-guard-test-'));
const S = path.join(T, 'scripts');   // the helper lives outside the company
const PMI = path.join(T, 'company', 'pm-inbox.jsonl');
const W = (rel, data) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); return f; };
const R = rel => { try { return fs.readFileSync(path.join(T, rel), 'utf8'); } catch (_) { return ''; } };
const line = o => JSON.stringify(o) + '\n';

const dead = (() => { const r = spawnSync(process.execPath, ['-e', "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>console.log(p))})"], { encoding: 'utf8' }); return Number(r.stdout.trim()); })();
const baseEnv = () => { const e = Object.assign({}, process.env, { CAPHEOS_ROOT: T, PROVENANCE_ROOT: T, CAPHEOS_TZ: 'UTC', STARNET_URL: 'http://127.0.0.1:' + dead }); for (const k of Object.keys(STATION_PINS)) delete e[k]; for (const k of ['OWNER_DIR', 'PM_INBOX_FILE', 'CONSOLE_PORT', 'STARNET_AGENT_ID', 'GOVERNANCE_ROOT']) delete e[k]; return e; };
const envOf = o => Object.assign(baseEnv(), o && o.agent ? STATION_PINS : {}, o && o.agentId ? { STARNET_AGENT_ID: o.agentId } : {});
function run(cmd, opts) {
  const r = spawnSync(process.execPath, [path.join(S, 'helper.js'), cmd].concat((opts && opts.args) || []), { env: envOf(opts), encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, cmd + ' failed: ' + r.stderr + r.stdout);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}
// a company tool's own CLI, as the owner's side or an agent's run
function cli(tool, args, opts) {
  const r = spawnSync(process.execPath, [path.join(T, 'company', 'tools', tool)].concat(args), { env: envOf(opts), encoding: 'utf8', timeout: 60000 });
  let j = null; try { j = JSON.parse(r.stdout); } catch (_) {}
  return { status: r.status, json: j, out: r.stdout + r.stderr };
}
// what the station's transcript shows: `agentId` ran `command` just now (provenance.callerConflict reads it)
function transcript(agentId, command) {
  const f = W('.starnet-data/workspaces/transcript-history-v2/segment-000001.jsonl', '');
  fs.writeFileSync(f, line({ agentId, ts: Date.now(), sourceRunId: 'run-' + agentId + '-0001', toolCalls: [{ function: { name: 'shell', arguments: JSON.stringify({ command }) } }] }));
}
const rows = () => R('company/pm-inbox.jsonl').split('\n').filter(Boolean).map(l => JSON.parse(l));

test.before(() => {
  fs.cpSync(path.join(REPO, 'company'), path.join(T, 'company'), { recursive: true });
  for (const d of ['company/owner', 'company/state', 'company/work']) fs.rmSync(path.join(T, d), { recursive: true, force: true });
  fs.rmSync(PMI, { force: true });
  const cj = JSON.parse(fs.readFileSync(path.join(REPO, 'company', 'company.json'), 'utf8'));
  cj.owner = Object.assign({}, cj.owner, { name: 'Pat' }); cj.station = Object.assign({}, cj.station, { url: 'http://127.0.0.1:' + dead, port: dead, serviceName: 'pm-inbox-guard-test' });
  W('company/company.json', cj);
  W('.pm-inbox-guard-strict', '');   // a temp company, but with the full program check (lib/pm-inbox-guard.js throwaway)
  W('company/tools/loops.json', { agents: {
    agent: { name: 'Alex', functions: ['ceo', 'people', 'tools', 'floor', 'finance'], inbox: 'to-alex.md', wakeOnOwnerMessage: true, manager: null },
    sam: { name: 'Sam', functions: [], inbox: 'to-sam.md', manager: 'agent' },
    rae: { name: 'Rae', functions: ['risk'], inbox: 'to-rae.md', manager: 'agent' } } });
  for (const n of ['alex', 'sam', 'rae']) W('company/work/handoffs/to-' + n + '.md', '# Handoffs\n');
  W('company/pm-inbox.jsonl',
    line({ type: 'ask', id: QID, at: '2026-11-01T00:00:00Z', from: 'Sam', q: 'May we raise the cap?', gate: { category: 'budget', ref: 'budget:x', by: 'Sam', summary: 'raise the cap' } }) +
    line({ type: 'answer', id: QID, at: '2026-11-01T01:00:00Z', a: 'yes', answer: { verdict: 'yes', action: 'approve', values: {} }, by: 'Commander' }) +
    line({ type: 'ask', id: QOLD, at: '2026-11-01T02:00:00Z', from: 'Sam', message: 'May we try the new layout?', q: 'May we try the new layout?' }));
  fs.mkdirSync(S, { recursive: true });
  fs.writeFileSync(path.join(S, 'helper.js'), `
'use strict';
const fs = require('fs'), path = require('path');
const T = process.env.CAPHEOS_ROOT, tool = n => require(path.join(T, 'company', 'tools', n));
const PMI = path.join(T, 'company', 'pm-inbox.jsonl');
const out = o => console.log(JSON.stringify(o));
(async () => {
  const [cmd, a1, a2] = process.argv.slice(2);
  if (cmd === 'read') {
    const ib = tool('inbox.js'), gov = tool('lib/governance.js'), G = tool('lib/pm-inbox-guard.js');
    const st = ib.state(); const pick = id => st[id] ? { a: st[id].a || null, closed: st[id].type === 'close', withdrawn: !!st[id].withdrawnAll, reclassified: st[id].reclassified || null, snoozedUntil: st[id].snoozedUntil || null } : null;
    const ids = (a1 || '').split(',').filter(Boolean);
    return out({ open: ib.openQuestions().map(q => q.id), state: Object.fromEntries(ids.map(id => [id, pick(id)])),
      answer: gov.answerOf('${QID}', { root: T }), approved: gov.approved('budget:x', { root: T }), pending: gov.pendingGates({ root: T }).map(q => q.id),
      trust: G.judge({ file: PMI }).lines.map(l => (l.row && l.row.type) + ':' + (l.row && l.row.id) + ':' + l.trust) });
  }
  if (cmd === 'forge') {
    // an agent's run, three ways: a plain append, the owner's own function, and a hand-recorded provenance row
    const at = new Date().toISOString();
    fs.appendFileSync(PMI, JSON.stringify({ type: 'answer', id: '${QID}', at, a: 'yes', answer: { verdict: 'yes', action: 'approve', values: {} }, by: 'Commander' }) + '\\n');
    let refused = null; try { tool('inbox.js').answer({ id: a1, by: 'Commander', text: 'yes' }); } catch (e) { refused = { code: e.code, msg: e.message }; }
    const l3 = JSON.stringify({ type: 'close', id: a1, at, by: 'Commander' }) + '\\n';
    tool('provenance.js').appended(PMI, l3, 'console'); fs.appendFileSync(PMI, l3);
    return out({ underStation: tool('provenance.js').underStation(), refused });
  }
  if (cmd === 'forge-withdraw') {
    // Alex's run takes back Sam's question by hand: a row that names Sam, and one recorded with Alex's own seat
    const at = new Date().toISOString();
    fs.appendFileSync(PMI, JSON.stringify({ type: 'withdraw', id: a1, at, why: 'not needed', by: 'Sam' }) + '\\n');
    const l2 = JSON.stringify({ type: 'reclassify', id: a1, at, note: 'the company decides', by: 'Sam' }) + '\\n';
    tool('provenance.js').appended(PMI, l2, 'inbox.js', { seat: 'agent' }); fs.appendFileSync(PMI, l2);
    return out({ underStation: tool('provenance.js').underStation() });
  }
  if (cmd === 'tick') {
    const r = await tool('locked-watch.js').tick({ root: T, home: path.join(T, 'home'), jobs: [], connectors: null, guards: { harnessSelfEdit: true }, log: () => {} });
    return out({ initialized: !!r.initialized, events: (r.events || []).map(e => ({ key: e.key, kind: e.kind, why: e.why })), notes: r.notes || [] });
  }
  throw new Error('unknown ' + cmd);
})().catch(e => { console.error(e.stack); process.exit(1); });
`);
});
test.after(() => { fs.rmSync(T, { recursive: true, force: true }); });

const opt = { skip: UNDER_STATION ? 'an agent run: the owner side of this test cannot run here' : false };
let ASKED = null, ASKED2 = null;

test('history before the cutover: readable, never a gate answer; the cutover is recorded once', opt, () => {
  const r = run('read', { args: [QID + ',' + QOLD] });
  assert.equal(r.state[QID].a, 'yes', 'the old answer still shows (Today, the asker\'s list)');
  assert.deepEqual(r.open, [QOLD], 'the old open question is still open');
  assert.equal(r.answer, null, 'a historic "yes" is no gate answer');
  assert.equal(r.approved, null);
  assert.deepEqual(r.trust, ['ask:' + QID + ':historic', 'answer:' + QID + ':historic', 'ask:' + QOLD + ':historic']);
  run('read');
  const cuts = R('company/state/locked/provenance.jsonl').split('\n').filter(l => l.includes('"kind":"cutover"') && l.includes('pm-inbox.jsonl'));
  assert.equal(cuts.length, 1, 'one cutover only'); assert.equal(JSON.parse(cuts[0]).bytes, fs.statSync(PMI).size);
  // a question asked through the tool after the cutover is trusted
  const a = cli('inbox.js', ['ask', '--from', 'Sam', '--message', 'May we send the newsletter on Friday? It is ready and lets us reach readers; if you skip it, we wait a week.']);
  assert.equal(a.status, 0, a.out); ASKED = a.json.id;
  const b = cli('inbox.js', ['ask', '--from', 'Sam', '--message', 'May we archive the old wiki? Nobody reads it, so it saves clutter; if you skip it, it stays.'], { agent: true });
  assert.equal(b.status, 0, 'an ask from the asker\'s own run: ' + b.out); ASKED2 = b.json.id;
  const r2 = run('read');
  assert.deepEqual(r2.open, [QOLD, ASKED, ASKED2]);
  assert.ok(r2.trust.slice(3).every(x => x.endsWith(':verified')), JSON.stringify(r2.trust));
  assert.ok(run('tick').initialized, 'the watcher\'s baseline');
});

test('a forged answer or close from an agent\'s run is ignored by every reader, logged, raised to risk once, and quarantined', opt, () => {
  const f = run('forge', { agent: true, args: [ASKED] });
  assert.equal(f.underStation, true, 'the forging child is an agent\'s run');
  assert.equal(f.refused && f.refused.code, 3, 'inbox.answer refuses to write the owner\'s answer from an agent\'s run: ' + JSON.stringify(f.refused));
  assert.equal(rows().filter(x => x.type === 'answer').length, 2, 'the forged plain append is in the file (one historic answer + one forged)');
  const r = run('read', { args: [QID + ',' + ASKED] });
  assert.equal(r.answer, null, 'governance.answerOf ignores the forged "yes"');
  assert.equal(r.approved, null, 'and it never approves');
  assert.ok(r.pending.includes(QID), 'the gate is still waiting for the owner');
  assert.equal(r.state[ASKED].a, null); assert.equal(r.state[ASKED].closed, false, 'the forged close is ignored');
  assert.ok(r.open.includes(ASKED), 'Today and the dispatcher still see the question open');
  const told = R('company/work/handoffs/to-rae.md');
  run('read');   // again: each row raised once, not per read
  const log = R('company/work/security/pm-inbox-ignored.jsonl').trim().split('\n').map(JSON.parse);
  assert.deepEqual(log.map(x => x.type + ':' + x.id).sort(), ['answer:' + QID, 'close:' + ASKED]);
  assert.ok(log.every(x => x.msg === 'unverified pm-inbox row ignored'));
  assert.equal(R('company/work/handoffs/to-rae.md'), told, 'the risk seat is not told twice');
  assert.equal((told.match(/answer q-000123 at offset/g) || []).length, 1, told);
  assert.equal((told.match(new RegExp('close ' + ASKED + ' at offset', 'g')) || []).length, 1, told);
  const t = run('tick');
  const e = t.events.find(x => x.key === 'company/pm-inbox.jsonl');
  assert.ok(e && e.kind === 'stripped', JSON.stringify(t));
  const now = R('company/pm-inbox.jsonl');
  assert.equal(rows().filter(x => x.type === 'answer' || x.type === 'close').length, 1, 'only the historic answer is left: ' + now);
  assert.ok(now.includes(ASKED) && now.includes(QOLD));
  const q = fs.readdirSync(path.join(T, 'company/state/locked/quarantine')).filter(n => n.endsWith('.lines') && n.includes('pm-inbox'));
  assert.equal(q.length, 1); const ql = fs.readFileSync(path.join(T, 'company/state/locked/quarantine', q[0]), 'utf8');
  assert.equal(ql.trim().split('\n').length, 2, ql);
});

test('a withdraw of another seat\'s question is refused; a hand-appended one is ignored; the asker\'s own works', opt, () => {
  // Alex's run claims to be Sam: the transcript shows Alex ran it
  transcript('agent', 'node company/tools/inbox.js withdraw ' + ASKED + ' --why "not needed" --from Sam');
  let w = cli('inbox.js', ['withdraw', ASKED, '--why', 'not needed', '--from', 'Sam'], { agent: true });
  assert.equal(w.status, 3, w.out); assert.match(w.json.error, /another seat's run/);
  // the station says the run is Alex's
  transcript('sam', 'unrelated');
  w = cli('inbox.js', ['withdraw', ASKED, '--why', 'not needed', '--from', 'Sam'], { agent: true, agentId: 'agent' });
  assert.equal(w.status, 3, w.out); assert.match(w.json.error, /only its own question/);
  // naming yourself is not enough either
  w = cli('inbox.js', ['withdraw', ASKED, '--why', 'not needed', '--from', 'Alex'], { agent: true });
  assert.equal(w.status, 3, w.out); assert.match(w.json.error, /only the asker \(Sam\)/);
  w = cli('inbox.js', ['reclassify', '--id', ASKED, '--note', 'the company decides', '--by', 'Alex'], { agent: true });
  assert.equal(w.status, 3, w.out);
  // by hand: ignored, and a row recorded with the wrong seat is ignored too
  run('forge-withdraw', { agent: true, args: [ASKED] });
  let r = run('read', { args: [ASKED] });
  assert.equal(r.state[ASKED].withdrawn, false); assert.equal(r.state[ASKED].reclassified, null);
  assert.ok(r.open.includes(ASKED), 'still open on Today');
  const log = R('company/work/security/pm-inbox-ignored.jsonl');
  assert.ok(/"type":"withdraw"/.test(log) && /"type":"reclassify"[^\n]*not written by the asker/.test(log), log);
  assert.equal(run('tick').events.find(x => x.key === 'company/pm-inbox.jsonl').kind, 'stripped');
  // Sam's own run withdraws Sam's question: accepted, recorded with Sam's seat, trusted
  transcript('sam', 'node company/tools/inbox.js withdraw ' + ASKED2 + ' --why "done another way" --from Sam');
  w = cli('inbox.js', ['withdraw', ASKED2, '--why', 'done another way', '--from', 'Sam'], { agent: true, agentId: 'sam' });
  assert.equal(w.status, 0, w.out);
  r = run('read', { args: [ASKED2] });
  assert.equal(r.state[ASKED2].withdrawn, true); assert.ok(!r.open.includes(ASKED2));
  assert.ok(r.trust.includes('withdraw:' + ASKED2 + ':verified'), JSON.stringify(r.trust));
  assert.ok(!run('tick').events.some(x => x.key === 'company/pm-inbox.jsonl'), 'the watcher leaves the asker\'s own row alone');
});

test('the console answer (Today), Today, a snooze and an approval answered in chat still work and are trusted', opt, async () => {
  const ap = cli('approvals.js', ['ask', '--from', 'Sam', '--category', 'spend', '--message', 'May we buy one month of the example data plan for $20? It unblocks the price study.', '--params', '{"amountUsd":20}']);
  assert.equal(ap.status, 0, ap.out); assert.equal(ap.json.minted, true, ap.out);
  const snz = cli('inbox.js', ['ask', '--from', 'Sam', '--message', 'May we change the logo next month? It gives us a fresher look; if you skip it, we keep the old one.']);
  assert.equal(snz.status, 0, snz.out);
  const child = spawn(process.execPath, [path.join(REPO, 'console', 'server.js'), '--port', '0', '--print-port'], { env: baseEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; child.stderr.on('data', d => { err += d; });
  try {
    const port = await new Promise((res, rej) => { let b = ''; child.stdout.on('data', d => { b += d; const m = b.match(/\{"port":(\d+)\}/); if (m) res(Number(m[1])); }); child.on('exit', c => rej(new Error('console exited ' + c + ': ' + err))); setTimeout(() => rej(new Error('console did not start: ' + err)), 20000); });
    assert.notEqual(port, 8800);
    const token = fs.readFileSync(path.join(T, 'secrets', 'console-token'), 'utf8').trim();
    const call = (method, p, body) => new Promise((res, rej) => {
      const data = body ? JSON.stringify(body) : null;
      const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: Object.assign({ 'x-console-token': token }, data ? { 'content-type': 'application/json' } : {}) }, r => { let d = ''; r.on('data', c => { d += c; }); r.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} res({ status: r.statusCode, json: j }); }); });
      req.on('error', rej); if (data) req.write(data); req.end();
    });
    let r = await call('GET', '/api/today');
    assert.equal(r.status, 200);
    const today = r.json.needsYou.questions.map(q => q.id);
    assert.ok(today.includes(ASKED) && today.includes(QOLD) && today.includes(ap.json.id) && !today.includes(ASKED2), JSON.stringify(today));
    r = await call('POST', '/api/questions/' + ASKED + '/answer', { action: 'approve', values: {} });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    r = await call('POST', '/api/questions/' + snz.json.id + '/snooze', { until: new Date(Date.now() + 86400e3).toISOString() });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    r = await call('GET', '/api/approvals/' + ap.json.id);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    r = await call('POST', '/api/approvals/' + ap.json.id + '/answer', { verdict: 'yes', shownDigest: r.json.actionDigest });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    r = await call('GET', '/api/questions/answered?since=' + encodeURIComponent(new Date(Date.now() - 3600e3).toISOString()));
    assert.equal(r.status, 200);
    const answered = JSON.stringify(r.json);
    assert.ok(answered.includes(ASKED) && answered.includes(ap.json.id), answered);
    const rd = run('read', { args: [ASKED, snz.json.id, ap.json.id].join(',') });
    assert.match(String(rd.state[ASKED].a), /^yes/, JSON.stringify(rd.state));
    assert.ok(rd.state[snz.json.id].snoozedUntil);
    assert.ok(rd.state[ap.json.id].a, 'the chat answer is the approval\'s answer');
    assert.ok(rd.trust.filter(x => /^(answer|snooze|approval-journal):/.test(x) && !x.includes(QID)).every(x => x.endsWith(':verified')), JSON.stringify(rd.trust));
    const st = cli('approvals.js', ['get', ap.json.id]);
    assert.equal(st.json && (st.json.record || st.json).status, 'approved', st.out);
    assert.ok(!run('tick').events.some(x => x.key === 'company/pm-inbox.jsonl'), 'the watcher keeps every console row');
  } finally { child.kill(); }
});
