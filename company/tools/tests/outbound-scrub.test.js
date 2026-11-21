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
