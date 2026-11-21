#!/usr/bin/env node
/* company/patches/tests/0022.test.js — StarNet patch 0022 (OpenRouter free models never bill; the outbound scrub),
 * against a real StarNet checkout and a stub OpenRouter server on loopback. Nothing reaches the internet; no key is real.
 *
 *   node company/patches/tests/0022.test.js [--starnet <dir>] [--quick]
 *
 * The checkout is $CAPHEOS_STARNET_SRC, --starnet, or <repo>/starnet (none: SKIP, exit 0). It is never written: it is
 * copied to a temp dir (company/patches/tests/starnet-copy.js) and the record applied there. --quick leaves out
 * StarNet's own OpenRouter and prompt-scrub tests.
 *
 * Cases: the station's scrub module is the framework's file byte for byte; every outbound message kind (system, user,
 * assistant tool-call arguments, tool results, the cache-control parts) leaves without any company secret value or any
 * secret-shaped sample, each replaced by [REDACTED:<kind>]; clean text is byte-identical; redactions are counted in the
 * scrub log without values; a ':free' id and a catalog id priced 0 carry max_price 0 and a free `models` list; a paid id
 * carries none, and free-only refuses it with no request sent; a missing pattern file refuses with nothing sent; the
 * daily free-model 429 is not retried. Then StarNet's own OpenRouter and prompt-scrub tests on the patched copy.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const crypto = require('crypto');
const assert = require('assert');

const REPO = path.resolve(__dirname, '..', '..', '..');
const life = require(path.join(REPO, 'company', 'tools', 'lib', 'temp-life.js'));
const RECORD = path.join(REPO, 'company', 'patches', '0022-openrouter-free-scrub.diff');
const PATTERNS = path.join(REPO, 'company', 'tools', 'lib', 'secret-patterns.json');
const ENGINE = path.join(REPO, 'company', 'tools', 'lib', 'outbound-scrub.js');
const SC = require('./starnet-copy');
const argv = process.argv.slice(2);
const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const QUICK = argv.includes('--quick');
const ENV_KEYS = ['STARNET_SCRUB_SECRETS_DIR', 'STARNET_SCRUB_PATTERNS', 'STARNET_SCRUB_LOG', 'STARNET_OPENROUTER_FREE_POOL', 'STARNET_OPENROUTER_FREE_ONLY', 'STARNET_OPENROUTER_FREE_ALTERNATES'];

// secret-shaped samples, built at run time (no key-shaped literal is tracked in this file)
const rnd = (n, set) => { const cs = set || 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; let s = ''; const b = crypto.randomBytes(n); for (let i = 0; i < n; i++) s += cs[b[i] % cs.length]; return s; };
const SAMPLES = {
  'openrouter-key': 'sk-' + 'or-v1-' + rnd(64, '0123456789abcdef'),
  'anthropic-key': 'sk-' + 'ant-api03-' + rnd(80),
  'github-token': 'gh' + 'p_' + rnd(36),
  'aws-key-id': 'AK' + 'IA' + rnd(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'),
  'slack-token': 'xo' + 'xb-' + rnd(12, '0123456789') + '-' + rnd(24),
  'jwt': 'ey' + 'J' + rnd(20) + '.ey' + 'J' + rnd(30) + '.' + rnd(40),
  'private-key': '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----\n' + rnd(64) + '\n' + rnd(64) + '\n-----END ' + 'OPENSSH PRIVATE KEY-----',
};
const SHAPED = {   // the secret part of an assignment-like sample (the text around it stays)
  bearer: ['Authorization: Bearer ', rnd(40)],
  cookie: ['Cookie: ', 'sid=' + rnd(32) + '; theme=dark'],
  assignment: ['password=', rnd(18)],
};

const results = [];
async function tcase(name, fn) {
  const t0 = Date.now();
  try { const r = await fn(); if (r && r.skip) { results.push(['SKIP', name]); console.log('  SKIP  ' + name + ' — ' + r.skip); } else { results.push(['PASS', name]); console.log('  PASS  ' + name + ' (' + (Date.now() - t0) + ' ms)'); } }
  catch (e) { results.push(['FAIL', name]); console.log('  FAIL  ' + name + '\n' + String(e && e.stack || e).split('\n').slice(0, 8).map(l => '        | ' + l).join('\n')); }
}

function stubServer() {
  const seen = [];
  let mode = 'ok';
  const srv = http.createServer((req, res) => {
    let d = ''; req.on('data', c => { d += c; }); req.on('end', () => {
      if (req.method === 'GET' && req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [
          { id: 'vendor-z/zero-priced', context_length: 1000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
          { id: 'vendor-p/paid', context_length: 1000, pricing: { prompt: '0.000001', completion: '0.000002' }, supported_parameters: ['tools'] } ] }));
      }
      if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
        seen.push({ raw: d, headers: req.headers });
        if (mode === 'daily') { res.writeHead(429, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { code: 429, message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day' } })); }
        let model = 'x'; try { model = JSON.parse(d).model; } catch (_) {}
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ id: 'gen-1', model, choices: [{ delta: { content: 'done' } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ id: 'gen-1', model, choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, cost: 0 } }) + '\n\n');
        return res.end('data: [DONE]\n\n');
      }
      res.writeHead(404); res.end('{}');
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, seen, url: 'http://127.0.0.1:' + srv.address().port, setMode: m => { mode = m; } })));
}

async function drain(it) { const evs = []; for await (const ev of it) evs.push(ev); return evs; }

(async () => {
  const src = SC.findSource(arg('--starnet'));
  if (!src) { console.log('SKIP 0022: no StarNet checkout (set CAPHEOS_STARNET_SRC)'); return; }
  let copy;
  await tcase('the record applies to a copy of the checkout', () => { copy = SC.prepare(src, RECORD, 'capheos-0022-'); });
  if (!copy) return finish();
  const dir = copy.dir;
  await tcase('the station\'s scrub module is the framework\'s file, byte for byte', () => {
    assert.strictEqual(fs.readFileSync(path.join(dir, 'sidecar', 'outbound-scrub.js'), 'utf8'), fs.readFileSync(ENGINE, 'utf8'));
  });

  const tmp = life.tmpDir('capheos-0022-env-');
  const secrets = path.join(tmp, 'secrets'); fs.mkdirSync(secrets);
  const VAL = { token: rnd(48, 'abcdef0123456789'), pass: 'Pw-' + rnd(14), json: rnd(30), line2: 'second-line-' + rnd(10), short: 'abc1234' };
  fs.writeFileSync(path.join(secrets, 'station-token'), VAL.token + '\n');
  fs.writeFileSync(path.join(secrets, 'db-password'), VAL.pass);
  fs.writeFileSync(path.join(secrets, 'service.json'), JSON.stringify({ client: { secret: VAL.json } }));
  fs.writeFileSync(path.join(secrets, 'multi.env'), 'FIRST=' + VAL.line2 + '\n');
  fs.writeFileSync(path.join(secrets, 'tiny'), VAL.short);   // 7 chars: not long enough to be matched as a value
  const pool = path.join(tmp, 'free-models.json');
  fs.writeFileSync(pool, JSON.stringify({ v: 1, at: new Date().toISOString(), models: [{ id: 'vendor-a/one:free', tools: true }, { id: 'vendor-b/two:free', tools: true }, { id: 'vendor-c/three:free', tools: false }, { id: 'vendor-d/four:free', tools: true }], ranked: ['vendor-a/one:free', 'vendor-b/two:free', 'vendor-c/three:free', 'vendor-d/four:free'] }));
  const logFile = path.join(tmp, 'scrub.jsonl');
  const setEnv = vars => { for (const k of ENV_KEYS) delete process.env[k]; Object.assign(process.env, vars || {}); };
  const BASE_ENV = { STARNET_SCRUB_SECRETS_DIR: secrets, STARNET_SCRUB_PATTERNS: PATTERNS, STARNET_SCRUB_LOG: logFile, STARNET_OPENROUTER_FREE_POOL: pool };
  setEnv(BASE_ENV);

  const S = await stubServer();
  const OR = require(path.join(dir, 'sidecar', 'providers', 'openrouter.js'));
  const mk = () => OR.makeOpenRouterProvider({ key: 'test-key', baseUrl: S.url, clock: { now: () => Date.now() } });
  const CLEAN = 'Please refactor the parser in src/lib/parse.js and keep the commit sha 3bae6b2 in the note.';
  const messages = () => [
    { role: 'system', content: 'You are a careful engineer. The deploy token is ' + VAL.token + '. ' + CLEAN },
    { role: 'user', content: 'Here is the env:\n' + SHAPED.assignment.join('') + '\nand ' + SAMPLES['openrouter-key'] + ' plus ' + SAMPLES['github-token'] + '\n' + CLEAN },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'shell_exec', arguments: JSON.stringify({ cmd: 'curl -H "' + SHAPED.bearer.join('') + '" https://example.com', note: VAL.pass }) } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'output:\n' + SAMPLES['aws-key-id'] + '\n' + SAMPLES['private-key'] + '\n' + SHAPED.cookie.join('') + '\n' + SAMPLES.jwt + '\n' + SAMPLES['slack-token'] + '\n' + SAMPLES['anthropic-key'] + '\nclient secret ' + VAL.json + ' / ' + VAL.line2 + ' / ' + VAL.short },
    { role: 'user', content: CLEAN },
  ];
  const tools = [{ type: 'function', function: { name: 'shell_exec', description: 'run a command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } } }];
  const lastBody = () => JSON.parse(S.seen[S.seen.length - 1].raw);

  await tcase('every outbound message kind leaves without a secret value or a secret-shaped sample', async () => {
    S.seen.length = 0;
    await drain(mk().stream({ model: 'vendor-a/one:free', messages: messages(), tools, runId: 'run-test-1', cacheSystemPrefix: 'You are a careful engineer.' }));
    assert.strictEqual(S.seen.length, 1);
    const raw = S.seen[0].raw;
    for (const [k, v] of Object.entries(VAL)) if (k !== 'short') assert.ok(!raw.includes(v), 'secret file value ' + k + ' left the machine');
    for (const [k, v] of Object.entries(SAMPLES)) assert.ok(!raw.includes(v.split('\n')[0]) && !raw.includes(v.slice(-20)), k + ' left the machine');
    for (const [k, [, v]] of Object.entries(SHAPED)) assert.ok(!raw.includes(v), k + ' value left the machine');
    for (const kind of ['secret-file', 'openrouter-key', 'github-token', 'aws-key-id', 'private-key', 'jwt', 'slack-token', 'anthropic-key', 'bearer', 'cookie', 'assignment'])
      assert.ok(raw.includes('[REDACTED:' + kind + ']'), 'no [REDACTED:' + kind + '] marker');
    assert.ok(raw.includes(VAL.short), 'a 7-character file value is not matched as a value');
  });
  await tcase('clean text is byte-identical; the tool-call arguments stay valid JSON; the request shape is kept', async () => {
    const b = lastBody();
    const last = b.messages[b.messages.length - 1];
    const text = typeof last.content === 'string' ? last.content : last.content.map(p => p.text).join('');
    assert.strictEqual(text, CLEAN);
    const tc = b.messages.find(m => m.tool_calls);
    const args = JSON.parse(tc.tool_calls[0].function.arguments);
    assert.ok(/\[REDACTED:(bearer|secret-file)\]/.test(args.cmd + args.note));
    assert.strictEqual(b.model, 'vendor-a/one:free'); assert.ok(Array.isArray(b.tools) && b.tools[0].function.name === 'shell_exec'); assert.strictEqual(b.stream, true);
  });
  await tcase('the scrub log counts the redactions for the run, never a value', async () => {
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const row = lines.find(r => r.runId === 'run-test-1');
    assert.ok(row && row.total >= 12 && row.counts['secret-file'] >= 4, JSON.stringify(row));
    const txt = fs.readFileSync(logFile, 'utf8');
    for (const v of Object.values(VAL).concat(Object.values(SAMPLES))) assert.ok(!txt.includes(v.split('\n')[0]), 'a value is in the scrub log');
    await drain(mk().stream({ model: 'vendor-a/one:free', messages: messages(), runId: 'run-test-1' }));
    assert.strictEqual(fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(l => /run-test-1/.test(l)).length, 1, 'one line per run while the count is the same');
  });
  await tcase('a :free model carries max_price 0 and a free models list (tools-capable ids only, at most 2 more)', async () => {
    S.seen.length = 0;
    await drain(mk().stream({ model: 'vendor-a/one:free', messages: [{ role: 'user', content: 'hi' }], tools }));
    const b = lastBody();
    assert.deepStrictEqual(b.provider, { max_price: { prompt: 0, completion: 0, request: 0, image: 0 } });
    assert.deepStrictEqual(b.models, ['vendor-a/one:free', 'vendor-b/two:free', 'vendor-d/four:free']);
  });
  await tcase('a catalog id priced 0 is free too; a paid id carries no max price', async () => {
    const p = mk(); await p.warmCatalog();
    S.seen.length = 0;
    await drain(p.stream({ model: 'vendor-z/zero-priced', messages: [{ role: 'user', content: 'hi' }] }));
    assert.deepStrictEqual(lastBody().provider, { max_price: { prompt: 0, completion: 0, request: 0, image: 0 } });
    await drain(p.stream({ model: 'vendor-p/paid', messages: [{ role: 'user', content: 'hi' }] }));
    assert.strictEqual(lastBody().provider, undefined); assert.strictEqual(lastBody().models, undefined);
  });
  await tcase('free-only: a paid id is refused before anything is sent; a free one runs with max_price 0', async () => {
    setEnv(Object.assign({}, BASE_ENV, { STARNET_OPENROUTER_FREE_ONLY: '1' }));
    try {
      const p = mk(); await p.warmCatalog();
      S.seen.length = 0;
      await assert.rejects(drain(p.stream({ model: 'vendor-p/paid', messages: [{ role: 'user', content: 'hi' }] })), /not a free model/);
      assert.strictEqual(S.seen.length, 0, 'nothing was sent');
      await drain(p.stream({ model: 'vendor-b/two:free', messages: [{ role: 'user', content: 'hi' }] }));
      assert.strictEqual(S.seen.length, 1); assert.strictEqual(lastBody().provider.max_price.completion, 0);
    } finally { setEnv(BASE_ENV); }
  });
  await tcase('a pattern list that cannot be read refuses the request: nothing is sent', async () => {
    setEnv(Object.assign({}, BASE_ENV, { STARNET_SCRUB_PATTERNS: path.join(tmp, 'missing.json') }));
    try {
      S.seen.length = 0;
      await assert.rejects(drain(mk().stream({ model: 'vendor-a/one:free', messages: [{ role: 'user', content: 'hi' }] })), /outbound scrub is not ready/);
      assert.strictEqual(S.seen.length, 0);
    } finally { setEnv(BASE_ENV); }
  });
  await tcase('neither scrub variable set: the request is as before (no extra pass)', async () => {
    setEnv({});
    try {
      S.seen.length = 0;
      await drain(mk().stream({ model: 'vendor-p/paid', messages: [{ role: 'user', content: 'plain ' + SHAPED.assignment.join('') }] }));
      assert.ok(S.seen[0].raw.includes(SHAPED.assignment[1]), 'unchanged without the scrub env');
      assert.strictEqual(lastBody().provider, undefined);
    } finally { setEnv(BASE_ENV); }
  });
  await tcase('the daily free-model limit (429 free-models-per-day) is not retried', async () => {
    S.setMode('daily'); S.seen.length = 0;
    try { await assert.rejects(drain(mk().stream({ model: 'vendor-a/one:free', messages: [{ role: 'user', content: 'hi' }] })), /429/); }
    finally { S.setMode('ok'); }
    assert.strictEqual(S.seen.length, 1, 'one request, no retry');
  });
  S.srv.close();

  if (!QUICK) {
    const tests = ['provider.openrouter.test.js', 'openrouter-free-daily-cap.test.js', 'openrouter-effort-heal.test.js', 'openrouter-inband-error.test.js', 'served-model.test.js', 'prompt-scrub.provider.test.js', 'prompt-scrub.test.js']
      .filter(f => fs.existsSync(path.join(dir, 'test', f)));
    await tcase('StarNet\'s own OpenRouter and prompt-scrub tests on the patched copy (' + tests.length + ' files)', () => {
      const env = Object.assign({}, process.env); for (const k of ENV_KEYS) delete env[k];
      const r = cp.spawnSync(process.execPath, ['--test'].concat(tests.map(f => path.join('test', f))), { cwd: dir, env, encoding: 'utf8', timeout: 150000 });
      if (r.status !== 0) throw new Error('node --test exited ' + r.status + '\n' + String(r.stdout || '').split('\n').filter(l => /not ok|fail|Error/i.test(l)).slice(0, 12).join('\n'));
    });
  }
  finish();
})().catch(e => { console.error(e); process.exit(1); });

function finish() {
  const failed = results.filter(r => r[0] === 'FAIL').length;
  console.log(failed ? '0022 TEST FAILED: ' + failed + ' of ' + results.length : '0022 TEST PASSED (' + results.length + ' cases)');
  process.exitCode = failed ? 1 : 0;
}
