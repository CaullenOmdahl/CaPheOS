#!/usr/bin/env node
/* approvals-console.test.js — the no-tool test on the REAL console server (console/server.js, not the dev mock):
 * every chat-action route a click can reach (the approval API from chat, the Needs-you answer of an approval, the key
 * store, the owner message, the chat send) is driven over HTTP while child_process (spawn, spawnSync, exec, execSync,
 * execFile, execFileSync, fork) is stubbed by a preload hook (-r) BEFORE any module loads, and the station is a
 * recorder. A click may send a message (the chat send's one POST /api/run), store a key, or answer an EXISTING approval
 * through approvals.js; it never runs a tool, never forks, and never reaches a station run or tool endpoint.
 * Also: the surface is the route's, never the body's (a crafted "console" or "needs-you" cannot answer a fixed gate from
 * the chat route), and a Needs-you answer of an approval goes through approvals.answer (digest, audit line, surface).
 *
 *   node --test company/tools/tests/approvals-console.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const AP = path.join(REPO, 'company', 'tools', 'approvals.js');
const roots = []; const kids = [];
test.after(() => { for (const k of kids) try { k.kill(); } catch (_) {} for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });

// the preload hook: every child_process entry point records the call (with the caller's stack) and throws
const HOOK = `'use strict';
const fs = require('fs'); const cp = require('child_process'); const LOG = process.env.NOTOOL_LOG;
for (const k of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  cp[k] = function () { const stack = String(new Error().stack).split('\\n').slice(2, 7).map(s => s.trim()); try { fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), fn: k, cmd: String(arguments[0]).slice(0, 200), stack }) + '\\n'); } catch (_) {} throw new Error('no-tool hook: child_process.' + k + ' called'); };
}`;

test('the real console server: no click path runs a tool, forks, or reaches a station run/tool endpoint; the surface is the route\'s', async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'approvals-console-selftest-')); roots.push(T);
  fs.cpSync(path.join(REPO, 'company'), path.join(T, 'company'), { recursive: true, filter: s => !/[\/\\]\.starnet-data([\/\\]|$)/.test(s) });
  for (const f of ['pm-inbox.jsonl']) try { fs.rmSync(path.join(T, 'company', f)); } catch (_) {}
  fs.rmSync(path.join(T, 'company', 'state'), { recursive: true, force: true }); fs.rmSync(path.join(T, 'company', 'owner'), { recursive: true, force: true });
  const w = (rel, data) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); };
  w('.capheos-selftest-fixture', '');
  w('company/company.json', Object.assign(JSON.parse(fs.readFileSync(path.join(REPO, 'company', 'company.json'), 'utf8')), { name: 'No-tool test', owner: { name: 'Olive Owner', title: 'Owner' }, timezone: 'UTC' }));
  w('company/tools/loops.json', { agents: { agent: { name: 'Founder', manager: null, functions: ['ceo', 'people', 'tools', 'risk', 'floor', 'finance'], inbox: 'to-founder.md', loop: 'Founder loop', wakeOnOwnerMessage: true }, sam: { name: 'Sam', manager: 'agent', inbox: 'to-sam.md' } } });
  w('company/work/decisions.md', '# Decisions\n\nNewest first. Who decided, what, why.\n');
  w('secrets/station-token', 'notool-station-token\n'); w('secrets/console-token', 'notool-console-token\n');
  const hook = path.join(T, 'notool-hook.js'); w('notool-hook.js', HOOK); const LOG = path.join(T, 'notool.jsonl'); w('notool.jsonl', '');

  // the station: a recorder. /api/run answers a finished run; everything else a harmless empty JSON
  const stationLog = [];
  const station = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; }); req.on('end', () => {
      stationLog.push({ method: req.method, path: req.url.split('?')[0], body: b.slice(0, 2000) });
      if (req.url.startsWith('/api/run')) { res.writeHead(200, { 'content-type': 'application/x-ndjson' }); res.end(JSON.stringify({ name: 'agent.run.end', payload: {} }) + '\n'); return; }
      if (req.url.split('?')[0] === '/api/cron') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jobs: [{ id: 'j-founder', name: 'Founder loop', agentId: 'agent', model: 'haiku', provider: 'claude-cli', enabled: true }] })); return; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
    });
  });
  station.unref(); await new Promise(r => station.listen(0, '127.0.0.1', r)); const sport = station.address().port; assert.notEqual(sport, 8800);

  const env = Object.assign({}, process.env, { CAPHEOS_ROOT: T, CAPHEOS_TZ: 'UTC', PROVENANCE_ROOT: T, STARNET_URL: 'http://127.0.0.1:' + sport, NOTOOL_LOG: LOG });
  delete env.CONSOLE_PORT;
  const ap = code => { const r = spawnSync(process.execPath, ['-e', 'const A = require(' + JSON.stringify(AP) + '); Promise.resolve((() => {' + code + '})()).then(v => console.log(JSON.stringify(v === undefined ? null : v)));'], { cwd: T, env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout.trim().split('\n').pop()); };
  const spend = ap('return A.ask({ from: "Sam", category: "spend", message: "May we buy one month of the example data plan for $20?", params: { amountUsd: 20 } });');
  const spend2 = ap('return A.ask({ from: "Sam", category: "spend", message: "And a second month for $20?", params: { amountUsd: 20, month: 2 } });');
  const fixed = ap('return A.ask({ from: "Sam", category: "access", message: "Could we get read access to the example bank account?", params: { account: "example" } });');
  assert.ok(spend.minted && spend2.minted && fixed.minted);

  const srv = spawn(process.execPath, ['-r', hook, path.join(REPO, 'console', 'server.js'), '--port', '0', '--host', '127.0.0.1', '--print-port'], { cwd: T, env, stdio: ['ignore', 'pipe', 'pipe'] }); kids.push(srv);
  let err = ''; srv.stderr.on('data', d => { err += d; });
  const port = await new Promise((res, rej) => { let d = ''; srv.stdout.on('data', c => { d += c; const m = /"port":(\d+)/.exec(d); if (m) res(Number(m[1])); }); srv.on('exit', c => rej(new Error('console exited ' + c + ': ' + err))); setTimeout(() => rej(new Error('console did not start: ' + err)), 20000); });
  const call = (method, p, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: Object.assign({ 'x-console-token': 'notool-console-token' }, data ? { 'content-type': 'application/json' } : {}) }, res => {
      let d = ''; res.on('data', c => { d += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} resolve({ status: res.statusCode, json: j, text: d }); });
    });
    req.on('error', reject); req.setTimeout(30000, () => req.destroy(new Error('timeout ' + p))); req.end(data);
  });
  const rows = () => fs.readFileSync(path.join(T, 'company', 'pm-inbox.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const answerOf = id => rows().filter(r => r.type === 'answer' && r.id === id);
  await call('GET', '/api/today');   // warm-up (start-up work is not a click)
  await new Promise(r => setTimeout(r, 300));
  const toolCalls = () => fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  // one click: the request, then what it reached (child_process calls and station requests made during it)
  const click = async (label, method, p, body) => {
    const n0 = toolCalls().length, s0 = stationLog.length;
    const r = await call(method, p, body);
    await new Promise(res => setTimeout(res, 150));
    const reached = { tools: toolCalls().slice(n0), station: stationLog.slice(s0) };
    assert.deepEqual(reached.tools, [], label + ': child_process was reached: ' + JSON.stringify(reached.tools));
    const runOrTool = reached.station.filter(x => /\/api\/(cron\/run|tools?\b|tool-|exec|shell|consent|loops\/control|agent\/run|run\/)/.test(x.path) || (x.method !== 'GET' && !/^\/api\/(run|projects(\/bless)?)$/.test(x.path)));
    assert.deepEqual(runOrTool, [], label + ': a station run/tool endpoint was reached: ' + JSON.stringify(runOrTool));
    return Object.assign(r, { reached });
  };

  // 1. a chat approve: the surface is "chat" whatever the body says
  let r = await click('chat approve', 'POST', '/api/approvals/' + spend.id + '/answer', { verdict: 'yes', shownDigest: spend.actionDigest, surface: 'needs-you' });
  assert.equal(r.status, 200, r.text); assert.equal(answerOf(spend.id)[0].surface, 'chat', 'the server set the surface from the route');
  assert.equal(r.reached.station.length, 0, 'an approval answer reaches no station endpoint at all');
  // 2. a crafted POST to the chat route cannot answer a fixed gate, with surface console, needs-you, cli or none
  for (const surface of ['console', 'needs-you', 'cli', undefined]) {
    r = await click('crafted fixed-gate answer (' + surface + ')', 'POST', '/api/approvals/' + fixed.id + '/answer', Object.assign({ verdict: 'yes', shownDigest: fixed.actionDigest }, surface ? { surface } : {}));
    assert.equal(r.status, 409, surface + ': ' + r.text); assert.equal(r.json.detail.code, 'route');
  }
  assert.equal(answerOf(fixed.id).length, 0, 'the fixed gate is still pending');
  // 3. Needs you answers the fixed gate through approvals.answer: surface needs-you, the audit line, the wake
  r = await click('Needs-you approve', 'POST', '/api/questions/' + fixed.id + '/answer', { action: 'approve', shownDigest: fixed.actionDigest });
  assert.equal(r.status, 200, r.text);
  const fa = answerOf(fixed.id); assert.equal(fa.length, 1); assert.equal(fa[0].surface, 'needs-you'); assert.equal(fa[0].shownDigest, fixed.actionDigest);
  assert.ok(fs.readFileSync(path.join(T, 'company/work/decisions.md'), 'utf8').includes('Approval ' + fixed.id + ' (access) approved by Olive Owner (surface: needs-you'));
  // 4. a plain reply on Needs you is not an answer to an approval
  r = await click('Needs-you reply to an approval', 'POST', '/api/questions/' + spend2.id + '/answer', { verdict: 'reply', text: 'sure, whatever' });
  assert.equal(r.status, 400, r.text); assert.equal(answerOf(spend2.id).length, 0);
  // 5. the key store, 6. the owner message, 7. the chat send (the click's reply message)
  r = await click('key store', 'POST', '/api/chat-actions/secret', { name: 'notool-feed-key', value: 'sk-notool-value-1234567890' });
  assert.equal(r.status, 200, r.text); assert.equal(r.reached.station.length, 0);
  r = await click('owner message', 'POST', '/api/owner/messages', { text: 'Chose: Keep it\n[actionReply {"id":"away","value":"keep"}]' });
  assert.equal(r.status, 200, r.text); assert.equal(r.reached.station.filter(x => x.method !== 'GET').length, 0);
  r = await click('chat send', 'POST', '/api/chat/agent/send', { text: 'Chose: Launch now\n[actionReply {"id":"launch","value":"now"}]' });
  assert.equal(r.status, 200, r.text);
  const runs = r.reached.station.filter(x => x.path === '/api/run');
  assert.equal(runs.length, 1, 'the chat send is ONE message to the station: ' + JSON.stringify(r.reached.station.map(x => x.method + ' ' + x.path)));
  assert.match(runs[0].body, /Chose: Launch now/);
  // 8. the reads
  for (const p of ['/api/approvals', '/api/approvals/' + spend2.id]) { r = await click('GET ' + p, 'GET', p); assert.equal(r.status, 200, r.text); }
  assert.deepEqual(toolCalls().filter(c => /approvals|inbox|decision/.test(c.stack.join(' '))), [], 'the approval path never reached child_process');
  srv.kill(); station.close();
});
