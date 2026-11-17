#!/usr/bin/env node
/* fake-cli.js — a stand-in sign-in CLI for company/tools/tests/connectors.test.js (console/connectors.js). No network.
 *
 *   fake-cli.js loopback login [--no-print]   listen on 127.0.0.1:<random>, ask $BROWSER to open
 *                                             https://auth.example.invalid/start?cli_port=<port>&cli_state=<state> (and
 *                                             print it unless --no-print); a GET /callback?code=<43 chars>&state=<state>
 *                                             writes the credential and exits 0 (like `synpath login`)
 *   fake-cli.js device login                  print a one-time code and https://auth.example.invalid/device, wait for the
 *                                             file $FAKE_APPROVE, then write the credential (like `gh auth login --web`)
 *   fake-cli.js paste login                   print https://auth.example.invalid/paste and "Paste the code:", read a line;
 *                                             GOOD-CODE writes the credential, anything else exits 1
 *   fake-cli.js any hang                      start a grandchild, write its pid to $FAKE_PIDS, never finish
 *   fake-cli.js any keys-create               add an api key to the credential (mode $FAKE_MODE, default 600)
 *   fake-cli.js any verify                    exit 0 when the credential has an api key and $FAKE_EXPIRED does not exist
 *   fake-cli.js any logout                    exit 0
 * The credential: $FAKE_CRED_FILE, else ~/.config/fake/cred.json (a CLI that cannot be redirected).
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');
const [style, cmd, ...rest] = process.argv.slice(2);
const CRED = process.env.FAKE_CRED_FILE || path.join(process.env.HOME || os.homedir(), '.config', 'fake', 'cred.json');
const save = (o, mode) => { fs.mkdirSync(path.dirname(CRED), { recursive: true }); fs.writeFileSync(CRED, JSON.stringify(o)); fs.chmodSync(CRED, mode || 0o600); };
const load = () => { try { return JSON.parse(fs.readFileSync(CRED, 'utf8')); } catch (_) { return null; } };
const open = url => { if (process.env.BROWSER) spawnSync(process.env.BROWSER, [url], { stdio: 'ignore' }); };

if (cmd === 'login' && style === 'loopback') {
  const state = crypto.randomBytes(16).toString('hex');
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const ok = u.pathname === '/callback' && u.searchParams.get('state') === state && /^[A-Za-z0-9_-]{43}$/.test(u.searchParams.get('code') || '');
    res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain' }); res.end(ok ? 'signed in' : 'invalid');
    if (ok) { save({ session: 'fake-session-' + state.slice(0, 6) }); srv.close(); setTimeout(() => process.exit(0), 50); }
  });
  srv.listen(0, '127.0.0.1', () => {
    const url = 'https://auth.example.invalid/start?cli_port=' + srv.address().port + '&cli_state=' + state + '&cli_challenge=abc';
    if (!rest.includes('--no-print')) console.log('Open this URL to sign in: ' + url);
    open(url);
  });
} else if (cmd === 'login' && style === 'device') {
  console.error('! First copy your one-time code: WXYZ-1234');
  console.log('Open this URL to continue in your web browser: https://auth.example.invalid/device');
  const t = setInterval(() => { if (process.env.FAKE_APPROVE && fs.existsSync(process.env.FAKE_APPROVE)) { clearInterval(t); save({ session: 'fake-device' }); console.log('Logged in'); process.exit(0); } }, 100);
} else if (cmd === 'login' && style === 'paste') {
  console.log('Visit https://auth.example.invalid/paste?state=s1 and sign in.');
  process.stdout.write('Paste the code: ');
  let buf = ''; process.stdin.on('data', d => { buf += d; const i = buf.indexOf('\n'); if (i < 0) return;
    if (buf.slice(0, i).trim() === 'GOOD-CODE') { save({ session: 'fake-paste' }); console.log('Signed in'); process.exit(0); }
    console.error('invalid code'); process.exit(1); });
} else if (cmd === 'hang') {
  const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  if (process.env.FAKE_PIDS) fs.writeFileSync(process.env.FAKE_PIDS, process.pid + ' ' + g.pid);
  setInterval(() => {}, 1000);
} else if (cmd === 'keys-create') {
  const c = load(); if (!c) { console.error('Sign in first'); process.exit(1); }
  c.api_key = 'spk_k1.' + crypto.randomBytes(12).toString('hex'); save(c, parseInt(process.env.FAKE_MODE || '600', 8));
  console.log('Created key k1 and saved it to ' + CRED);
} else if (cmd === 'verify') {
  const c = load(); process.exit(c && c.api_key && !(process.env.FAKE_EXPIRED && fs.existsSync(process.env.FAKE_EXPIRED)) ? 0 : 1);
} else if (cmd === 'logout') {
  process.exit(0);
} else { console.error('fake-cli: unknown ' + style + ' ' + cmd); process.exit(2); }
