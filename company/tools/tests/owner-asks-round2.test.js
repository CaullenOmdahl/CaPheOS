#!/usr/bin/env node
/* owner-asks-round2.test.js — regression tests for the round-2 re-reviews of the owner-asks work (2026-11-19): the
 * safety re-review (N1, N2, S-a, S-b, S-c, the push note) and the experience re-review (N1 to N5 and the wording list).
 * Each case runs the real tools in a throwaway company (child processes, so each has its own CAPHEOS_ROOT); nothing
 * reaches a station, systemd or a network port (the console runs on a loopback port with a fake station).
 *
 *   node --test company/tools/tests/owner-asks-round2.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const SCRIPTS = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-r2-scripts-'));
const roots = [SCRIPTS];
test.after(() => { for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });
const W = (root, rel, v) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v, null, 1) + '\n'); return f; };
const STATION_ENV = ['STARNET_USER_CONTROL_MODE', 'STARNET_COMPUTER_DRIVER', 'STARNET_MCP_STDIO', 'STARNET_AGENT_ID', 'OWNER_DIR', 'PM_INBOX_FILE', 'GOVERNANCE_ROOT', 'CONSOLE_PORT', 'CAPHEOS_NOTICE_STRICT'];
function envFor(T, extra) { const e = Object.assign({}, process.env, { REPO, T, CAPHEOS_ROOT: T, PROVENANCE_ROOT: T, CAPHEOS_TZ: 'UTC', STARNET_URL: 'http://127.0.0.1:9' }, extra || {}); for (const k of STATION_ENV) if (!(extra && k in extra)) delete e[k]; return e; }
let nScript = 0;
function run(T, code, o) {
  const f = path.join(SCRIPTS, 's' + (++nScript) + '.js');
  fs.writeFileSync(f, "'use strict';\nconst fs = require('fs'), path = require('path');\nconst REPO = process.env.REPO, T = process.env.T;\nconst out = o => console.log(JSON.stringify(o));\n" +
    "try { require(path.join(REPO, 'company/tools/provenance.js')).pinUnderStation(false); } catch (_) {}\n" + code);
  const r = spawnSync(process.execPath, [f], { env: envFor(T, o && o.env), encoding: 'utf8', timeout: 180000 });
  assert.equal(r.status, 0, 'script failed: ' + r.stderr + r.stdout);
  const last = r.stdout.trim().split('\n').pop();
  try { return JSON.parse(last); } catch (_) { throw new Error('no JSON from the script: ' + r.stdout + r.stderr); }
}
function company(o) {
  o = o || {};
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-r2-')); roots.push(T);
  W(T, 'company/company.json', { name: 'OC', slug: 'oc', owner: { name: 'Pat Owner' }, timezone: 'UTC', station: { url: 'http://127.0.0.1:9' } });
  W(T, 'company/tools/loops.json', { agents: o.agents || {
    agent: { name: 'Alex', manager: null, functions: ['ceo'], inbox: 'to-alex.md' },
    engineer: { name: 'Max', manager: 'agent', functions: ['tools'], inbox: 'to-max.md' },
    auditor: { name: 'Riley', manager: 'agent', functions: ['risk'], inbox: 'to-riley.md' },
    people: { name: 'Nadia Farrell', manager: 'agent', functions: ['people'], inbox: 'to-nadia.md' },
    sam: { name: 'Sam Lee', manager: 'agent', inbox: 'to-sam.md' } } });
  fs.mkdirSync(path.join(T, 'company', 'work', 'handoffs'), { recursive: true });
  const g = JSON.parse(fs.readFileSync(path.join(REPO, 'company/defaults/state/governance.json'), 'utf8'));
  Object.assign(g.categories, o.levels || {});
  W(T, 'company/defaults/state/governance.json', g); W(T, 'company/state/governance.json', g);
  W(T, 'company/defaults/state/guardrails.json', fs.readFileSync(path.join(REPO, 'company/defaults/state/guardrails.json'), 'utf8'));
  if (o.allowlist) W(T, 'company/state/external-allowlist.txt', o.allowlist.join('\n') + '\n');
  return T;
}
// a full copy of the framework (company/ and console/), for the console's own modules and the tools' own paths
function fixture(o) {
  o = o || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-r2-fx-')); roots.push(root);
  fs.cpSync(path.join(REPO, 'company'), path.join(root, 'company'), { recursive: true, filter: s => !/[\/\\]\.starnet-data([\/\\]|$)/.test(s) });
  fs.cpSync(path.join(REPO, 'console'), path.join(root, 'console'), { recursive: true });
  if (o.modules) fs.cpSync(path.join(REPO, 'modules'), path.join(root, 'modules'), { recursive: true });
  W(root, 'secrets/station-token', 'fake-token\n');
  for (const f of ['company/state/locked/provenance.jsonl', 'company/pm-inbox.jsonl', 'company/state/governance.json', 'company/state/owner-rulings.json', 'company/owner/digest.jsonl']) try { fs.rmSync(path.join(root, f)); } catch (_) {}
  W(root, 'company/company.json', { name: 'Fixture Co', slug: 'fixture-co', timezone: 'UTC', owner: { name: 'Olive' }, station: { url: 'http://127.0.0.1:9' } });
  W(root, 'company/tools/loops.json', { agents: o.agents || { boss: { name: 'Boss', functions: ['ceo'], manager: null, inbox: 'to-boss.md' }, hal: { name: 'Hal', functions: ['people'], manager: 'boss', inbox: 'to-hal.md' },
    riley: { name: 'Riley', functions: ['risk'], manager: 'boss', inbox: 'to-riley.md' }, data: { name: 'Halima', manager: 'boss', inbox: 'to-halima.md' } } });
  const g = JSON.parse(fs.readFileSync(path.join(REPO, 'company/defaults/state/governance.json'), 'utf8')); Object.assign(g.categories, o.levels || {});
  W(root, 'company/state/governance.json', g);
  return root;
}
async function consoleOn(root, fn) {
  const fake = http.createServer((req, res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"fake"}'); });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const env = Object.assign({}, process.env, { CAPHEOS_ROOT: root, STARNET_URL: 'http://127.0.0.1:' + fake.address().port, CAPHEOS_TZ: 'UTC' });
  for (const k of STATION_ENV.concat(['CAPHEOS_READONLY'])) delete env[k];
  const child = spawn(process.execPath, [path.join(root, 'console', 'server.js'), '--port', '0', '--print-port'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let errText = ''; child.stderr.on('data', x => { errText += x; });
  try {
    const port = await new Promise((resolve, reject) => { let buf = ''; child.stdout.on('data', x => { buf += x; const m = buf.match(/\{"port":(\d+)\}/); if (m) resolve(Number(m[1])); }); child.on('exit', c => reject(new Error('server exited ' + c + ': ' + errText))); setTimeout(() => reject(new Error('server did not start: ' + errText)), 15000); });
    const token = fs.readFileSync(path.join(root, 'secrets', 'console-token'), 'utf8').trim();
    const call = (method, p, body) => new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: Object.assign({ 'x-console-token': token }, data ? { 'content-type': 'application/json' } : {}) }, res => {
        let x = ''; res.on('data', c => { x += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(x); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
      });
      req.setTimeout(120000, () => req.destroy(new Error('timeout ' + p))); req.on('error', reject); if (data) req.write(data); req.end();
    });
    await fn(call, () => errText);
  } finally { child.kill(); fake.close(); }
}
const PLAIN_RE = /node |--[a-z]|\.js\b|\.json\b|sha256|company\/|\b[a-z]+[A-Z][a-zA-Z]+\b|\bq-\d+|\bhc-\d+/;

/* ---------------- safety N1: the protected-file keep card ---------------- */
// a locked-watch context over a few manifest entries, with a fake transcript the tools read
const LW_CTX = `
const L = require(path.join(T, 'company/tools/locked-watch.js'));
const SEG = path.join(T, '.starnet-data/workspaces/transcript-history-v2/segment-000001.jsonl');
fs.mkdirSync(path.dirname(SEG), { recursive: true }); if (!fs.existsSync(SEG)) fs.writeFileSync(SEG, '');
const said = (agentId, name, args, ts) => fs.appendFileSync(SEG, JSON.stringify({ agentId, sourceRunId: 'run-' + agentId + '-1234', ts, toolCalls: JSON.stringify([{ id: 'c', type: 'function', function: { name, arguments: JSON.stringify(args) } }]) }) + '\\n');
const manFor = keys => L.MANIFEST.filter(m => keys.includes(m.p));
const ctxFor = (keys, now) => L.context({ root: T, home: path.join(T, 'home'), manifest: manFor(keys), ownerShell: false, underStation: false, log: () => {}, now: now || Date.now() });
const ask = (keys, key, o, now) => { try { return L.askAcceptCmd(ctxFor(keys, now), key, o); } catch (e) { return 'ERR ' + e.message; } };
const G = require(path.join(T, 'company/tools/lib/pm-inbox-guard.js'));
const cards = () => G.rows({ file: path.join(T, 'company/pm-inbox.jsonl'), noAlert: true }).filter(x => x.type === 'ask' && x.effect && x.effect.lockedAccept);
`;

test('safety N1 (poc-locked): an edit to the spending cap, the external gate or a tool that runs as the owner is never kept with one click', async () => {
  const T = fixture();
  W(T, 'company/work/finance/dispatch-budget.json', '{"dailyUsd":5}\n');
  const keys = ['company/work/finance/dispatch-budget.json', 'company/tools/external-gate.js', 'company/tools/pack.js', 'company/tools/module.js', 'company/state/governance.json'];
  const r = run(T, LW_CTX + `
const keys = ${JSON.stringify(keys)};
L.tick(ctxFor(keys));
fs.writeFileSync(path.join(T, keys[0]), '{"dailyUsd":5000}');
for (const k of keys.slice(1, 4)) fs.appendFileSync(path.join(T, k), '\\n// gate opened\\n');
L.tick(ctxFor(keys));
const res = keys.map(k => ask(keys, k, { by: 'Riley', why: 'routine tidy-up, nothing changes for you', plain: 'a routine tidy-up' }));
out({ res, cards: cards().length, inMan: keys.map(k => manFor([k]).length) });`);
  assert.deepEqual(r.inMan, [1, 1, 1, 1, 1], 'pack.js and module.js are watched (S-a)');
  for (const [i, k] of keys.entries()) {
    if (i === 4) continue;   // governance.json: nothing flagged (it did not change), refused before it is even looked at
    assert.match(r.res[i], /^ERR .*fixed gates/, k + ' is refused: ' + r.res[i]);
    assert.match(r.res[i], /harness-change\.js propose/, 'and pointed at the reviewed path');
  }
  assert.match(r.res[4], /^ERR .*fixed gates/);
  assert.equal(r.cards, 0, 'no keep card at all');
  await consoleOn(T, async (call) => {
    const q = await call('GET', '/api/questions');
    assert.equal((q.json.questions || []).filter(x => x.effectKind === 'lockedAccept').length, 0, 'nothing on Today');
  });
  assert.equal(fs.readFileSync(path.join(T, 'company/work/finance/dispatch-budget.json'), 'utf8'), '{"dailyUsd":5000}');
  const b = JSON.parse(fs.readFileSync(path.join(T, 'company/state/locked/baseline.json'), 'utf8'));
  assert.ok(b.files['company/work/finance/dispatch-budget.json'].flagged, 'the edit stays flagged, never accepted');
});

test('safety N1: the keep card says what changed (old to new), why, and what happens on no; --by is checked and the editor cannot ask', () => {
  const T = fixture();
  const key = 'company/competence-policy.json';
  W(T, key, JSON.stringify({ weights: { handoffs: 2, tests: 1 } }, null, 1) + '\n');
  const r = run(T, LW_CTX + `
const keys = [${JSON.stringify(key)}];
const now = Date.now();
L.tick(ctxFor(keys, now - 60000));
said('hal', 'fs_edit', { path: ${JSON.stringify(key)} }, now - 50000);
fs.writeFileSync(path.join(T, ${JSON.stringify(key)}), JSON.stringify({ weights: { handoffs: 3, tests: 1 } }, null, 1) + '\\n');
L.tick(ctxFor(keys, now - 40000));
const flaggedBy = JSON.parse(fs.readFileSync(path.join(T, 'company/state/locked/baseline.json'), 'utf8')).files[${JSON.stringify(key)}].flagged.by;
const plain = 'late handoffs now count for more in the weekly scores';
const editor = ask(keys, ${JSON.stringify(key)}, { by: 'Hal', why: 'late handoffs hurt the customers most', plain }, now);
const noPlain = ask(keys, ${JSON.stringify(key)}, { by: 'Riley', why: 'late handoffs hurt the customers most' }, now);
const techPlain = ask(keys, ${JSON.stringify(key)}, { by: 'Riley', why: 'late handoffs hurt the customers most', plain: 'raise weights.handoffs in competence-policy.json' }, now);
const stranger = ask(keys, ${JSON.stringify(key)}, { by: 'Halima', why: 'late handoffs hurt the customers most', plain }, now);
said('boss', 'shell_exec', { command: 'node company/tools/locked-watch.js ask-accept ${key} --by Riley --why x' }, now - 1000);
const forged = ask(keys, ${JSON.stringify(key)}, { by: 'Riley', why: 'late handoffs hurt the customers most', plain }, now);
said('riley', 'shell_exec', { command: 'node company/tools/locked-watch.js ask-accept ${key} --by Riley --why x' }, now - 500);
const ok = ask(keys, ${JSON.stringify(key)}, { by: 'Riley', why: 'late handoffs hurt the customers most', plain, ifNo: 'the scores stay as they are and the crew puts the old weights back' }, now);
const c = cards().pop() || null;
out({ flaggedBy, editor, noPlain, techPlain, stranger, forged, ok, card: c && { message: c.message, consequence: c.consequence, recommendation: c.recommendation, technical: c.technical } });`);
  assert.deepEqual(r.flaggedBy, ['hal'], 'the watcher names the editor');
  assert.match(r.editor, /^ERR .*own run.*cannot be the one recommending/, r.editor);
  assert.match(r.noPlain, /^ERR --plain must say/, r.noPlain);
  assert.match(r.techPlain, /^ERR not plain for the owner/, r.techPlain);
  assert.match(r.stranger, /^ERR Halima may not do this/, r.stranger);
  assert.match(r.forged, /^ERR .*ran in Boss's run/, 'a --by typed in someone else\'s run is refused: ' + r.forged);
  assert.match(r.ok, /asked the owner/, r.ok);
  assert.ok(r.card);
  assert.match(r.card.message, /Riley asks you to keep a change to one of the limits the crew works within: late handoffs now count for more in the weekly scores\. One value changes from 2 to 3\./);
  assert.match(r.card.consequence, /If you say no or do not answer, the scores stay as they are and the crew puts the old weights back\./);
  assert.match(r.card.recommendation, /^Riley recommends yes: late handoffs hurt the customers most\./);
  assert.doesNotMatch(r.card.message + r.card.consequence + r.card.recommendation, PLAIN_RE);
  assert.match(r.card.technical, /edited in the run of Hal/);
});

/* ---------------- safety S-a: the add-on tools that run as the owner are owner-gated and locked ---------------- */
test('S-a: pack.js and module.js are owner-gated (harness-change) and watched (locked-watch)', () => {
  const H = require(path.join(REPO, 'company/tools/harness-change.js'));
  const L = require(path.join(REPO, 'company/tools/locked-watch.js'));
  const locked = new Set(L.MANIFEST.map(m => m.p));
  for (const f of ['pack.js', 'module.js']) {
    assert.ok(H.OWNER_GATE_TOOLS['company/tools/' + f], f + ' is owner-gated');
    assert.ok(locked.has('company/tools/' + f), f + ' is locked');
  }
});

/* ---------------- safety N2 / UX N5 and UX N4: background jobs with network ---------------- */
const SVC_CTX = `
const S = require(path.join(REPO, 'company/tools/service.js'));
const calls = [];
const svcOpts = x => Object.assign({ root: T, unitDir: path.join(T, 'units'), transientDir: path.join(T, 'transient'), systemctl: a => { calls.push(a.join(' ')); return { code: 0, out: '', err: '' }; },
  journal: () => '', isAgent: () => true, ownerShell: () => false, guard: () => true, halted: () => false, callerConflict: () => null }, x || {});
const tryIt = fn => { try { return { ok: true, r: fn() }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; } };
const G = require(path.join(REPO, 'company/tools/lib/pm-inbox-guard.js'));
const asks = () => G.rows({ file: path.join(T, 'company/pm-inbox.jsonl'), noAlert: true }).filter(x => x.type === 'ask');
const unit = n => fs.existsSync(path.join(T, 'units', 'oc-svc-' + n + '.service'));
`;
test('safety N2: with the guardrail on, an allowlisted website at schedules=auto and external=auto is never installed by the crew; no network still is', () => {
  const T = company({ levels: { schedules: 'auto', external: 'auto' }, allowlist: ['api.known.example'] });
  W(T, 'company/work/feed.py', 'print(1)\n');
  const r = run(T, SVC_CTX + `
// an agent appends a site to the allowlist, then proposes a job for it
fs.appendFileSync(path.join(T, 'company/state/external-allowlist.txt'), 'evil.example\\n');
const net = tryIt(() => S.propose(S.context(svcOpts()), 'feed', { by: 'sam', kind: 'timer', exec: 'python3 company/work/feed.py', every: '1h', why: 'pulls prices for the desk every hour', hosts: 'evil.example' }));
const quiet = tryIt(() => S.propose(S.context(svcOpts()), 'quiet', { by: 'sam', kind: 'timer', exec: 'python3 company/work/feed.py', every: '1h', why: 'tidies the price files every hour' }));
const c = asks().find(x => x.effect && x.effect.serviceApprove && x.effect.serviceApprove.name === 'feed') || null;
out({ net, quiet, feedUnit: unit('feed'), quietUnit: unit('quiet'), card: c && { category: c.gate.category, guardrail: !!c.gate.guardrail, message: c.message } });`);
  assert.equal(r.net.r.waiting, true, 'waits for the owner: ' + JSON.stringify(r.net));
  assert.equal(r.feedUnit, false, 'nothing installed');
  assert.equal(r.card.category, 'localComputer'); assert.equal(r.card.guardrail, true);
  assert.match(r.card.message, /It connects to the Evil website but nothing stops it reaching others, so company data could leave\./);
  assert.equal(r.quiet.r.status, 'installed', 'a job with no network is still the crew\'s to install');
  assert.equal(r.quietUnit, true);
});
test('UX N4: a job outside the safe profile for another reason still names the website on its card', () => {
  const T = company({ levels: { schedules: 'auto', external: 'approve' } });
  W(T, 'company/work/feed.py', 'print(1)\n');
  const r = run(T, SVC_CTX + `
const a = tryIt(() => S.propose(S.context(svcOpts()), 'tape', { by: 'sam', kind: 'service', exec: 'python3 company/work/feed.py', why: 'records the live price tape all day', hosts: 'api.newfeed.example', 'soft-halt': 'keep' }));
const c = asks().pop() || null;
out({ a, message: c && c.message, technical: c && c.technical });`);
  assert.equal(r.a.r.waiting, true, JSON.stringify(r.a));
  assert.match(r.message, /the Newfeed website, which is new to the crew/, 'the website a yes approves is on the card: ' + r.message);
  assert.match(r.technical, /--soft-halt keep/, 'and the other reason is in the technical part');
});
