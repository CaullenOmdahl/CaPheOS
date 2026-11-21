'use strict';
/* outbound-scrub.test.js — the secret formats (company/tools/lib/secret-patterns.json) and the engine
 * (company/tools/lib/outbound-scrub.js) that StarNet patch 0022 runs on every OpenRouter request (docs/FREE-MODELS.md).
 * Every key-shaped sample is built at run time: none is a literal in this file. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const life = require('../lib/temp-life');
const S = require('../lib/outbound-scrub');

const P = S.loadPatterns(path.join(__dirname, '..', 'lib', 'secret-patterns.json'));
const rnd = (n, set) => { const cs = set || 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; let s = ''; const b = crypto.randomBytes(n); for (let i = 0; i < n; i++) s += cs[b[i] % cs.length]; return s; };
const HEX = '0123456789abcdef';
const scrub = (text, values) => { const counts = {}; const out = S.makeScrubber({ patterns: P, values: values || [] }).text(text, counts); return { out, counts }; };

const HITS = [
  ['anthropic-key', () => 'sk-' + 'ant-api03-' + rnd(60)],
  ['openrouter-key', () => 'sk-' + 'or-v1-' + rnd(64, HEX)],
  ['openai-key', () => 'sk-' + 'proj-' + rnd(48)],
  ['github-token', () => 'gh' + 'p_' + rnd(36)],
  ['github-token', () => 'gh' + 'o_' + rnd(36)],
  ['github-token', () => 'github' + '_pat_' + rnd(22) + '_' + rnd(59)],
  ['gitlab-token', () => 'gl' + 'pat-' + rnd(20)],
  ['aws-key-id', () => 'AK' + 'IA' + rnd(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')],
  ['slack-token', () => 'xo' + 'xp-' + rnd(10, '0123456789') + '-' + rnd(24)],
  ['google-key', () => 'AI' + 'za' + rnd(35)],
  ['stripe-key', () => 's' + 'k_live_' + rnd(24)],
  ['private-key', () => '-----BEGIN ' + 'RSA PRIVATE KEY-----\n' + rnd(64) + '\n-----END ' + 'RSA PRIVATE KEY-----'],
  ['jwt', () => 'ey' + 'J' + rnd(20) + '.ey' + 'J' + rnd(40) + '.' + rnd(43)],
  ['hex-token', () => rnd(64, HEX)],
  ['high-entropy', () => crypto.randomBytes(48).toString('base64')],
  ['slack-webhook', () => 'https://hooks.' + 'slack.com/services/T' + rnd(8) + '/B' + rnd(8) + '/' + rnd(24)],
  ['discord-webhook', () => 'https://discord.' + 'com/api/webhooks/' + rnd(18, '0123456789') + '/' + rnd(60)],
  ['discord-token', () => 'M' + rnd(20, '0123456789') + 'aB' + rnd(2) + '.' + rnd(6) + '.' + 'Xy9' + rnd(30)],
];
const SHAPED = [   // [kind, the text before, the secret part, the text after]
  ['bearer', 'Authorization: Bearer ', () => rnd(40), ''],
  ['basic-auth', 'Authorization: Basic ', () => Buffer.from('user:' + rnd(16)).toString('base64'), ''],
  ['url-password', 'postgres://admin:', () => rnd(14), '@db.example.com:5432/app'],
  ['cookie', 'Cookie: ', () => 'session=' + rnd(32), ''],
  ['cookie', 'Set-Cookie: ', () => 'sid=' + rnd(24) + '; HttpOnly', ''],
  ['assignment', 'password=', () => rnd(16), ''],
  ['assignment', 'export API_TOKEN=', () => rnd(24), ''],
  ['assignment', '{"client_secret": "', () => rnd(20), '"}'],
  ['assignment', "db_password: '", () => rnd(12), "'"],
  ['assignment', 'https://api.example.com/v1/a?token=', () => rnd(12), ''],
  ['assignment', 'https://api.example.com/v1/a?b=1&password=', () => 'hunter2' + rnd(6), '&c=2'],
  ['assignment', 'password: ', () => 'Tr0ub' + rnd(4) + '&3horse', ''],
  ['assignment', 'api_key: ', () => rnd(16, 'abcdef0123456789'), ''],
  ['assignment', 'the token: ', () => rnd(6, 'abcdef') + rnd(6, '0123456789'), ' is what it printed'],
  ['auth-header', 'X-Api-Key: ', () => rnd(32, HEX), ''],
  ['auth-header', 'X-Auth-Token: ', () => rnd(20), ''],
  ['auth-header', 'Authorization: token ', () => rnd(40), ''],
  ['cli-secret', 'mysql --password ', () => 'hunter2' + rnd(6), ' -u root'],
  ['url-password', 'redis://:', () => 'mypassword' + rnd(4, '0123456789'), '@cache.example.com:6379'],
];
const MISSES = [
  'git log 3bae6b2a8d9f0c1e2b3a4d5c6e7f8091a2b3c4d5 (a 40-character commit sha)',
  'const token = req.headers.authorization;',
  'password = getPassword()',
  'TOKEN=$GITHUB_TOKEN and token: ${TOKEN} and password=<your password>',
  'docker pull image@sha256:' + rnd(64, HEX),
  '"integrity": "sha512-' + crypto.randomBytes(64).toString('base64') + '"',
  'src/components/UserProfileCardHeaderTitle.tsx and company/tools/lib/override-allow.js',
  'uuid 123e4567-e89b-12d3-a456-426614174000',
  'Write the sk-learn tutorial; pip install hf_transformers',
  'the passwords are hashed with bcrypt; set a token in the settings page',
  'use process.env.API_KEY here',
  // ordinary code a free model reads and edits must reach it unchanged
  'max_tokens=1000000',
  '"max_tokens": 1000000,',
  'client = Client(token=self.token)',
  'checksum = "' + rnd(64, HEX) + '"',
  '  token: string;',
  'def connect(api_key: Optional[str] = None):',
  'send({ token: authToken })',
  '  password: hashedPassword,',
  '  apiKey: process.env.API_KEY,',
  'headers: { Authorization: authHeader },',
  'for (const token of tokens) {',
  'pass the --token option, or --password <secret>',
  'Token: required.',
  '| File | What | Created by |',
  '|---|---|---|',
];

test('every listed secret format is removed and named by its kind', () => {
  for (const [kind, make] of HITS) {
    const v = make(); const { out, counts } = scrub('before ' + v + ' after');
    assert.ok(!out.includes(v), kind + ' sample survived: ' + out);
    assert.strictEqual(out, 'before [REDACTED:' + kind + '] after', kind + ': ' + out);
    assert.strictEqual(counts[kind], 1, kind + ' counted once: ' + JSON.stringify(counts));
  }
});
test('assignment-shaped secrets lose the secret part only', () => {
  for (const [kind, pre, make, post] of SHAPED) {
    const v = make(); const { out, counts } = scrub(pre + v + post);
    assert.ok(!out.includes(v), kind + ' survived: ' + out);
    assert.ok(out.startsWith(pre.trim()) || out.startsWith(pre), kind + ' kept its label: ' + out);
    assert.ok(out.includes('[REDACTED:' + kind + ']'), kind + ': ' + out + ' ' + JSON.stringify(counts));
  }
});
test('ordinary code and prose are left exactly as they are', () => {
  for (const s of MISSES) { const { out, counts } = scrub(s); assert.strictEqual(out, s, 'changed: ' + s + ' -> ' + out + ' ' + JSON.stringify(counts)); }
});
test('clean text comes back as the very same string; a marker is never matched again', () => {
  const s = 'nothing secret here at all, just a sentence about the build';
  assert.strictEqual(S.makeScrubber({ patterns: P }).text(s), s);
  const once = scrub('password="' + rnd(16) + '"').out;
  assert.strictEqual(scrub(once).out, once);
});
test('the company\'s secret files: exact values, lines, KEY=VALUE values and JSON strings; short ones and names never', () => {
  const dir = life.tmpDir('outbound-scrub-test-');
  const a = rnd(40), b = 'Pw-' + rnd(10), c = rnd(20), d = rnd(30);
  fs.writeFileSync(path.join(dir, 'service-token'), a + '\n');
  fs.writeFileSync(path.join(dir, 'app.env'), 'DB_PASS="' + b + '"\nOTHER=' + c + '\n');
  fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify({ nested: { key: d } }));
  fs.writeFileSync(path.join(dir, 'pin'), '12345678');   // 8 characters: too short to match as a value
  const V = S.valuesFromDir(dir, P.minValueLen);
  const text = 'see ' + a + ' and ' + b + ' then ' + c + ' or ' + d + ' with pin 12345678 from service-token';
  const { out, counts } = scrub(text, V);
  for (const v of [a, b, c, d]) assert.ok(!out.includes(v), 'value survived');
  assert.ok(out.includes('12345678') && out.includes('service-token'), 'a short value and a file name are not touched: ' + out);
  assert.ok(counts['secret-file'] >= 4, JSON.stringify(counts));
  assert.deepStrictEqual(S.valuesFromDir(path.join(dir, 'missing'), 9), []);
});
test('a secrets folder: README and *.md notes, comments and lines with no letter or digit are not values; subfolders are', () => {
  const dir = life.tmpDir('outbound-scrub-dir-');
  const key = rnd(24), nested = rnd(30), linked = rnd(26), outside = rnd(28), ml = 'line-one-' + rnd(12) + '\nline-two-' + rnd(12);
  fs.writeFileSync(path.join(dir, 'README.md'), '# secrets/\n\n| File | What | Created by |\n|---|---|---|\n| service-token | the token | setup |\n');
  fs.writeFileSync(path.join(dir, 'notes.md'), 'a note about the keys kept here\n');
  fs.writeFileSync(path.join(dir, 'app.env'), '# the database login for the reporting job\n=========================\nKEY=' + key + '\n');
  fs.mkdirSync(path.join(dir, 'ssh', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ssh', 'deploy_key'), nested + '\n');
  fs.writeFileSync(path.join(dir, 'ssh', 'deep', 'multi'), ml);
  const out = life.tmpDir('outbound-scrub-out-'); fs.writeFileSync(path.join(out, 'other'), outside);
  fs.writeFileSync(path.join(dir, 'ssh', 'real'), linked); fs.symlinkSync(path.join(dir, 'ssh', 'real'), path.join(dir, 'alias'));
  fs.symlinkSync(path.join(out, 'other'), path.join(dir, 'escape'));
  const V = S.valuesFromDir(dir, P.minValueLen);
  for (const v of [key, nested, linked, ml]) assert.ok(V.includes(v), 'a value is fed');
  assert.ok(!V.includes(outside), 'a symlink out of the folder is not followed');
  for (const v of ['| File | What | Created by |', '|---|---|---|', '# secrets/', '=========================', '# the database login for the reporting job', 'a note about the keys kept here']) assert.ok(!V.includes(v), 'not a secret: ' + v);
  const tbl = '| a | b | c |\n|---|---|---|\n| File | What | Created by |';
  assert.strictEqual(scrub(tbl, V).out, tbl, 'a markdown table is left alone');
  const sig = S.dirSignature(dir); fs.writeFileSync(path.join(dir, 'ssh', 'deep', 'multi'), ml + 'x'); assert.notStrictEqual(S.dirSignature(dir), sig, 'a change in a subfolder changes the signature');
  // the JSON-escaped and standalone base64 forms of a value
  const r1 = scrub('{"out":' + JSON.stringify(ml) + '}', V); assert.ok(!r1.out.includes(ml.split('\n')[0].slice(9)), 'the JSON-escaped form: ' + r1.out);
  const r2 = scrub('b64 ' + Buffer.from(key).toString('base64').replace(/=+$/, ''), V); assert.ok(r2.out.includes('[REDACTED:secret-file]'), 'the base64 form: ' + r2.out);
});
test('text that starts with "data:" is read like any text; a real data URI is decoded when it is text', () => {
  const key = 'sk-' + 'or-v1-' + rnd(64, HEX), val = rnd(30);
  const sc = S.makeScrubber({ patterns: P, values: [val] });
  for (const content of ['data: {"k":"' + key + '"}', 'data: ' + val + '\n\n']) {
    const c = {}, out = sc.body({ messages: [{ role: 'tool', tool_call_id: 'x', content }] }, c);
    const raw = JSON.stringify(out); assert.ok(!raw.includes(key) && !raw.includes(val), 'survived: ' + raw); assert.ok(S.total(c) >= 1);
  }
  const uri = 'data:text/plain;base64,' + Buffer.from('export TOKEN=' + val + '\n').toString('base64');
  const o2 = sc.body({ messages: [{ role: 'user', content: uri }] });
  assert.ok(!Buffer.from(o2.messages[0].content.split(',')[1], 'base64').toString('utf8').includes(val), 'a text data URI is scrubbed');
  const filePart = { type: 'file', file: { filename: 'notes.txt', file_data: uri } };
  const o3 = sc.body({ messages: [{ role: 'user', content: [filePart] }] });
  const fd = o3.messages[0].content[0].file.file_data; assert.ok(fd.startsWith('data:text/plain;base64,') && !Buffer.from(fd.split(',')[1], 'base64').toString('utf8').includes(val), 'a text file part is scrubbed');
  const png = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]), crypto.randomBytes(40)]).toString('base64');
  const o4 = sc.body({ messages: [{ role: 'user', content: [{ type: 'file', file: { filename: 'a.png', file_data: png } }, { type: 'text', text: png }] }] });
  assert.strictEqual(o4.messages[0].content[0].file.file_data, png); assert.strictEqual(o4.messages[0].content[1].text, png, 'binary bytes are left as they are');
});
test('a body nested past the depth cap is refused, never sent half read; reasoning text is scrubbed', () => {
  let deep = { content: 'gh' + 'p_' + rnd(36) }; for (let i = 0; i < S._internals.MAX_DEPTH + 2; i++) deep = { x: deep };
  assert.throws(() => S.makeScrubber({ patterns: P }).body({ messages: [deep] }), /nested deeper/);
  const key = 'gh' + 'p_' + rnd(36);
  const out = S.makeScrubber({ patterns: P }).body({ messages: [{ role: 'assistant', content: 'ok', reasoning: 'I saw ' + key }] });
  assert.ok(!JSON.stringify(out).includes(key));
});
test('a request body: messages, tool-call arguments and parts are scrubbed; ids, images and wire fields are not', () => {
  const key = 'gh' + 'p_' + rnd(36), img = 'data:image/png;base64,' + crypto.randomBytes(60).toString('base64');
  const body = { model: 'vendor/x:free', models: ['vendor/x:free'], stream: true, provider: { max_price: { prompt: 0 } }, messages: [
    { role: 'system', content: [{ type: 'text', text: 'token ' + key, cache_control: { type: 'ephemeral' } }] },
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: img } }] },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_' + rnd(40), type: 'function', function: { name: 'shell_exec', arguments: JSON.stringify({ cmd: 'echo ' + key }) } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'printed ' + key }] };
  const counts = {};
  const out = S.makeScrubber({ patterns: P }).body(body, counts);
  const raw = JSON.stringify(out);
  assert.ok(!raw.includes(key)); assert.strictEqual(counts['github-token'], 3);
  assert.ok(raw.includes(img), 'an image is not text'); assert.strictEqual(out.messages[2].tool_calls[0].id, body.messages[2].tool_calls[0].id);
  assert.strictEqual(out.model, body.model); assert.strictEqual(out.messages[1], body.messages[1], 'an unchanged message is the same object');
  assert.ok(JSON.parse(out.messages[2].tool_calls[0].function.arguments).cmd.includes('[REDACTED:github-token]'));
  assert.strictEqual(S.makeScrubber({ patterns: P }).body({ messages: [{ role: 'user', content: 'hi' }] }).messages[0].content, 'hi');
});
test('the pattern list is well formed: kinds, sources, and a broken list refuses to load', () => {
  assert.ok(P.patterns.length >= 20);
  for (const p of P.patterns) assert.ok(/^[a-z0-9-]+$/.test(p.kind));
  assert.throws(() => S.compile({ patterns: [] }), /no patterns/);
  assert.throws(() => S.compile({ patterns: [{ kind: 'X Y', re: 'a' }] }), /malformed/);
});
