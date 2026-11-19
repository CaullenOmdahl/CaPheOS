#!/usr/bin/env node
/* remote-access-test.js — the console operated from another machine's browser (docs/DEPLOY-SERVER.md), offline.
 *
 *   node tests/remote-access-test.js
 *
 * Starts console/server.js against a temp copy of company/ with a dead station (never port 8800) and checks:
 *   - every new owner action (console/owner-ops.js) needs the owner's sign-in, refuses a cookie write without the CSRF
 *     token, and is recorded as the owner's in company/state/owner-ops.jsonl;
 *   - login: a form POST, never a token in the address; cookie flags (HttpOnly, SameSite, Secure over HTTPS from a
 *     trusted proxy only); the rate limit (a spoofed X-Forwarded-For does not get round it); passphrase; one-time
 *     recovery code; sign out everywhere; the server admin's --reset-login;
 *   - no secret in an address or in the console's output (its log);
 *   - the bind address from config and env, with a warning beyond loopback; GET /api/health without auth;
 *   - SSE and the chat stream through a mock reverse proxy (no buffering header, events arrive as they happen);
 *   - the console comes back after a crash under scripts/supervise.js with every session still valid; the systemd
 *     unit restarts it too (Restart=always);
 *   - linger off is detected and reported (company/tools/lib/host.js), and is n/a in a container.
 * Exit 1 on any failed check.
 */
'use strict';
const life = require('../company/tools/lib/temp-life');   // temp dirs and helper processes end with the walk, on a kill too
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http'); const net = require('net');
const { spawn, spawnSync } = require('child_process');
const REPO = path.join(__dirname, '..');
const SERVER = path.join(REPO, 'console', 'server.js');
let fails = 0, n = 0;
const check = (name, ok, info) => { n++; if (!ok) fails++; console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok || info === undefined ? '' : '  ' + JSON.stringify(info).slice(0, 500))); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
async function until(fn, ms) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(100); } return v; }

function req(port, method, p, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const body = opts.json !== undefined ? JSON.stringify(opts.json) : opts.form !== undefined ? new URLSearchParams(opts.form).toString() : null;
    const headers = Object.assign({}, opts.json !== undefined ? { 'content-type': 'application/json' } : opts.form !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}, opts.headers || {});
    const r = http.request({ host: opts.host || '127.0.0.1', port, path: p, method, headers }, res => {
      let d = ''; res.on('data', c => { d += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} resolve({ status: res.statusCode, headers: res.headers, json: j, text: d }); });
    });
    r.setTimeout(60000, () => r.destroy(new Error('timeout ' + p))); r.on('error', reject); if (body) r.write(body); r.end();
  });
}
const cookieOf = (r, name) => { const c = (r.headers['set-cookie'] || []).find(x => x.startsWith(name + '=')); return c || null; };
const pair = c => c ? c.split(';')[0] : '';

/* a temp company root: company/ copied, secrets/, a dead station, stand-in restart scripts */
function makeRoot() {
  const tmp = life.tmpDir('remote-access-selftest-');
  fs.cpSync(path.join(REPO, 'company'), path.join(tmp, 'company'), { recursive: true, filter: s => !/[\/\\]\.starnet-data([\/\\]|$)/.test(s) });
  fs.cpSync(path.join(REPO, 'modules'), path.join(tmp, 'modules'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'secrets'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(tmp, 'secrets', 'station-token'), 'remote-selftest-station-token\n', { mode: 0o600 });
  fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
  for (const s of ['restart-station.sh', 'restart-console.sh']) fs.writeFileSync(path.join(tmp, 'scripts', s), '#!/bin/sh\necho "stand-in ' + s + ' $*" >> "' + path.join(tmp, 'restarts.log') + '"\n', { mode: 0o755 });
  fs.mkdirSync(path.join(tmp, 'units'), { recursive: true });
  const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'company', 'company.json'), 'utf8'));
  cfg.owner = Object.assign({}, cfg.owner, { name: 'Robin' }); fs.writeFileSync(path.join(tmp, 'company', 'company.json'), JSON.stringify(cfg, null, 2) + '\n');
  return tmp;
}
async function startConsole(root, env, args) {
  const port = await freePort(); const dead = await freePort();
  const e = Object.assign({}, process.env, { CAPHEOS_ROOT: root, STARNET_URL: 'http://127.0.0.1:' + dead, SERVICE_UNIT_DIR: path.join(root, 'units'), SERVICE_SYSTEMCTL: '/bin/true', CAPHEOS_SUPERVISOR: 'none' }, env || {});
  delete e.CONSOLE_PORT; if (!env || !('CONSOLE_HOST' in env)) delete e.CONSOLE_HOST;
  const child = life.track(spawn(process.execPath, [SERVER, '--port', String(port)].concat(args || []), { env: e, stdio: ['ignore', 'pipe', 'pipe'] }));
  const out = { text: '' }; child.stdout.on('data', d => { out.text += d; }); child.stderr.on('data', d => { out.text += d; });
  const up = await until(async () => { try { return (await req(port, 'GET', '/api/health', { host: (env && env.TEST_CONNECT) || '127.0.0.1' })).status === 200; } catch (_) { return false; } }, 15000);
  if (!up) throw new Error('console did not start: ' + out.text.slice(-500));
  return { port, child, out, stop: () => { try { child.kill(); } catch (_) {} } };
}
async function login(port, secret, headers) {
  const r = await req(port, 'POST', '/login', { json: { secret }, headers });
  return { r, cookie: [pair(cookieOf(r, 'capheos_session')), pair(cookieOf(r, 'capheos_csrf'))].filter(Boolean).join('; '), csrf: r.json && r.json.csrf };
}
const opsRows = root => { try { return fs.readFileSync(path.join(root, 'company', 'state', 'owner-ops.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch (_) { return []; } };

(async () => {
  const root = makeRoot();
  const procs = [];
  try {
    const A = await startConsole(root); procs.push(A);
    const token = fs.readFileSync(path.join(root, 'secrets', 'console-token'), 'utf8').trim();
    let r = await req(A.port, 'GET', '/api/health');
    check('GET /api/health answers without auth, with no detail', r.status === 200 && r.text === '{"ok":true}', r.text);

    /* ---- login ---- */
    r = await req(A.port, 'GET', '/login?token=' + token);
    check('a token in the login address signs nobody in', r.status === 400 && !r.headers['set-cookie'] && !r.text.includes(token));
    r = await req(A.port, 'GET', '/');
    check('signed out, / goes to the login page', r.status === 303 && r.headers.location === '/login');
    r = await req(A.port, 'GET', '/login');
    check('the login page is a form that POSTs (no token in it)', r.status === 200 && /<form method="post" action="\/login"/.test(r.text) && /type="password"/.test(r.text) && !r.text.includes(token) && /no-store/.test(r.headers['cache-control']));
    r = await req(A.port, 'POST', '/login', { form: { secret: token, next: '/#/today' } });
    const sc = cookieOf(r, 'capheos_session'), cc = cookieOf(r, 'capheos_csrf');
    check('form login: 303 to next, session cookie HttpOnly + SameSite=Lax + Max-Age, never the token', r.status === 303 && r.headers.location === '/#/today' && /HttpOnly/.test(sc) && /SameSite=Lax/.test(sc) && /Max-Age=\d+/.test(sc) && !sc.includes(token), sc);
    check('the CSRF cookie is readable by the page (not HttpOnly) and SameSite', cc && !/HttpOnly/.test(cc) && /SameSite=Lax/.test(cc));
    check('plain HTTP with no trusted proxy: no Secure flag (a browser would drop it)', !/Secure/.test(sc));
    r = await req(A.port, 'POST', '/login', { form: { secret: token, next: '//evil.example/x' } });
    check('next cannot send the browser to another site', r.status === 303 && r.headers.location === '/');
    let S = await login(A.port, token);
    r = await req(A.port, 'GET', '/api/company', { headers: { cookie: S.cookie } });
    check('the session cookie signs in to the API', r.status === 200 && r.json.ok);

    /* ---- CSRF ---- */
    r = await req(A.port, 'POST', '/api/ops/access', { json: { sessionHours: 100 }, headers: { cookie: S.cookie } });
    check('a cookie write without the CSRF token: 403', r.status === 403 && r.json.csrf === true, r.json);
    r = await req(A.port, 'POST', '/api/ops/access', { json: { sessionHours: 100 }, headers: { cookie: S.cookie, 'x-csrf-token': 'wrong' } });
    check('a wrong CSRF token: 403', r.status === 403);
    r = await req(A.port, 'POST', '/api/ops/access', { json: { sessionHours: 100 }, headers: { cookie: S.cookie, 'x-csrf-token': S.csrf, origin: 'https://evil.example' } });
    check('the right token from another site\'s page (Origin): 403', r.status === 403);
    r = await req(A.port, 'POST', '/api/ops/access', { json: { sessionHours: 100 }, headers: { cookie: S.cookie, 'x-csrf-token': S.csrf, origin: 'http://127.0.0.1:' + A.port } });
    check('the right token, same site: saved', r.status === 200 && r.json.ok && r.json.saved.sessionHours === 100, r.json);
    r = await req(A.port, 'POST', '/api/halt/soft', { json: { why: 'csrf' }, headers: { cookie: S.cookie } });
    check('CSRF applies to every POST, old routes too', r.status === 403);
    r = await req(A.port, 'POST', '/logout', { headers: { cookie: S.cookie } });
    check('/logout without the CSRF token is refused', r.status === 403);

    /* ---- each owner action: owner-only and recorded ---- */
    const H = { cookie: S.cookie, 'x-csrf-token': S.csrf };
    const actions = [
      ['flags.accept', '/api/ops/flags/accept', { key: 'company/work/finance/pacing-policy.json', why: 'owner reviewed this change' }],
      ['flags.revert', '/api/ops/flags/revert', { key: 'company/work/finance/pacing-policy.json', why: 'not meant' }],
      ['scheduler.migrate', '/api/ops/scheduler', { to: 'dispatcher', confirm: true }],
      ['scheduler.rollback', '/api/ops/scheduler', { to: 'station', confirm: true }],
      ['services.adopt', '/api/ops/services/adopt', { unit: 'stray-recorder' }],
      ['modules.enable', '/api/ops/modules/liveness/enable', {}],
      ['modules.disable', '/api/ops/modules/liveness/disable', {}],
      ['guardrails.apply', '/api/ops/guardrails/apply', {}],
      ['restart.station', '/api/ops/restart/station', { reason: 'test' }],
      ['update.apply', '/api/ops/update/apply', { expect: 'abcdef1' }],
      ['access.set', '/api/ops/access', { trustProxy: true }],
    ];
    for (const [action, p, body] of actions) {
      const before = opsRows(root).length;
      const a = await req(A.port, 'POST', p, { json: body });
      const b = await req(A.port, 'POST', p, { json: body, headers: { cookie: S.cookie } });
      const c = await req(A.port, 'POST', p, { json: body, headers: H });
      const rows = opsRows(root).slice(before);
      check(action + ': signed out 401, no CSRF 403, as the owner it runs and is recorded as Robin (owner)', a.status === 401 && b.status === 403 && c.status !== 401 && c.status !== 403 && rows.length === 1 && rows[0].action === action && rows[0].by === 'Robin' && rows[0].via === 'console',
        { a: a.status, b: b.status, c: c.status, body: c.json, rows });
    }
    const mod = await req(A.port, 'GET', '/api/ops/modules', { headers: H });
    check('modules list reads', mod.status === 200 && Array.isArray(mod.json.items), mod.json);
    const fl = await req(A.port, 'GET', '/api/ops/flags', { headers: H });
    check('flags list reads (locked-watch status --json)', fl.status === 200 && Array.isArray(fl.json.flags), fl.json);
    await until(async () => fs.existsSync(path.join(root, 'restarts.log')), 5000);
    check('the station restart ran restart-station.sh --when-idle as the owner, detached', /restart-station\.sh --when-idle --max-wait-min 90 --reason test --by Robin/.test(fs.readFileSync(path.join(root, 'restarts.log'), 'utf8')));
    r = await req(A.port, 'GET', '/api/ops/jobs', { headers: H });
    check('the job and its output are listed', r.status === 200 && r.json.jobs.some(j => j.kind === 'restart-station'), r.json);
    r = await req(A.port, 'POST', '/api/ops/access', { json: { host: '0.0.0.0' }, headers: H });
    check('binding beyond loopback needs confirm', r.status === 400 && /confirm/.test(r.json.error));
    r = await req(A.port, 'POST', '/api/ops/access', { json: { host: '0.0.0.0', confirm: true }, headers: H });
    check('bind 0.0.0.0 with confirm: saved in company.json console.host', r.status === 200 && JSON.parse(fs.readFileSync(path.join(root, 'company', 'company.json'), 'utf8')).console.host === '0.0.0.0');
    r = await req(A.port, 'GET', '/api/ops/access', { headers: H });
    check('access shows the running bind (loopback) and the saved one', r.status === 200 && r.json.host === '127.0.0.1' && r.json.saved.host === '0.0.0.0' && r.json.saved.trustProxy === true, r.json);

    /* ---- rate limit ---- */
    for (let i = 0; i < 5; i++) await req(A.port, 'POST', '/login', { json: { secret: 'wrong-' + i }, headers: { 'x-forwarded-for': '203.0.113.' + i } });
    r = await req(A.port, 'POST', '/login', { json: { secret: token }, headers: { 'x-forwarded-for': '198.51.100.7' } });
    check('5 failures: the 6th try is 429 with Retry-After, even with the right token and a spoofed X-Forwarded-For', r.status === 429 && Number(r.headers['retry-after']) > 0, r.status);

    /* ---- passphrase, recovery code, sign out everywhere ---- */
    const B = await startConsole(root, { CONSOLE_TRUST_PROXY: 'false' }); procs.push(B);   // a fresh process: a fresh rate limit, the same sessions; env beats company.json
    r = await req(B.port, 'GET', '/api/company', { headers: { cookie: S.cookie } });
    check('a session survives a console restart (nothing kept in memory)', r.status === 200);
    r = await req(B.port, 'POST', '/api/auth/passphrase', { json: { passphrase: 'short' }, headers: H });
    check('a passphrase under 12 characters is refused', r.status === 400);
    r = await req(B.port, 'POST', '/api/auth/passphrase', { json: { passphrase: 'correct horse battery staple' }, headers: H });
    check('passphrase set (stored as a hash, 0600)', r.status === 200 && !fs.readFileSync(path.join(root, 'secrets', 'console-passphrase'), 'utf8').includes('horse') && (fs.statSync(path.join(root, 'secrets', 'console-passphrase')).mode & 0o777) === 0o600);
    let P = await login(B.port, 'correct horse battery staple');
    check('sign in with the passphrase', P.r.status === 200 && P.csrf);
    r = await req(B.port, 'POST', '/api/auth/recovery-code', { headers: H });
    const code = r.json && r.json.code;
    check('a one-time recovery code is shown once', r.status === 200 && /^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/.test(code) && !fs.readFileSync(path.join(root, 'secrets', 'console-recovery'), 'utf8').includes(code.replace(/-/g, '')));
    let R = await login(B.port, code);
    check('the recovery code signs in once', R.r.status === 200);
    R = await login(B.port, code);
    check('... and is used up', R.r.status === 401);
    r = await req(B.port, 'POST', '/api/auth/rotate', { headers: { cookie: P.cookie, 'x-csrf-token': P.csrf } });
    const newTok = r.json && r.json.token;
    const keep = [pair(cookieOf(r, 'capheos_session')), pair(cookieOf(r, 'capheos_csrf'))].join('; ');
    check('sign out everywhere: a new token, shown once', r.status === 200 && newTok && newTok !== token && fs.readFileSync(path.join(root, 'secrets', 'console-token'), 'utf8').trim() === newTok);
    r = await req(B.port, 'GET', '/api/company', { headers: { cookie: S.cookie } });
    check('... every other session is signed out (no restart needed)', r.status === 401);
    r = await req(B.port, 'GET', '/api/company', { headers: { cookie: keep } });
    check('... this browser stays signed in', r.status === 200);
    r = await req(A.port, 'GET', '/api/company', { headers: { 'x-console-token': token } });
    check('... and the old token no longer opens the API, in any running console', r.status === 401);

    /* ---- break-glass: the server admin's --reset-login ---- */
    const rl = spawnSync(process.execPath, [SERVER, '--reset-login'], { encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: root }), timeout: 20000 });
    const tok3 = fs.readFileSync(path.join(root, 'secrets', 'console-token'), 'utf8').trim();
    check('--reset-login: new token, passphrase gone, nothing secret printed to a pipe', rl.status === 0 && tok3 !== newTok && !fs.existsSync(path.join(root, 'secrets', 'console-passphrase')) && !(rl.stdout + rl.stderr).includes(tok3), rl.stdout + rl.stderr);
    r = await req(B.port, 'GET', '/api/company', { headers: { cookie: keep } });
    check('... every session ends at once', r.status === 401);
    P = await login(B.port, 'correct horse battery staple');
    check('... the old passphrase no longer works', P.r.status === 401);
    S = await login(B.port, tok3);
    check('... the owner signs in with the new token', S.r.status === 200);

    /* ---- trusted proxy, Secure cookies, SSE through a mock proxy ---- */
    const C = await startConsole(root, { CONSOLE_TRUST_PROXY: 'true' }); procs.push(C);
    r = await req(C.port, 'POST', '/login', { json: { secret: tok3 }, headers: { 'x-forwarded-proto': 'https' } });
    check('X-Forwarded-Proto https from a trusted proxy: Secure cookies', /; Secure/.test(cookieOf(r, 'capheos_session')) && /; Secure/.test(cookieOf(r, 'capheos_csrf')));
    r = await req(B.port, 'POST', '/login', { json: { secret: tok3 }, headers: { 'x-forwarded-proto': 'https' } });
    check('the same header from an untrusted peer is ignored (no Secure)', r.status === 200 && !/Secure/.test(cookieOf(r, 'capheos_session')));
    // the mock proxy: forwards everything, adds X-Forwarded-*, streams the answer chunk by chunk
    const proxyPort = await freePort();
    const proxy = http.createServer((pr, ps) => {
      const up = http.request({ host: '127.0.0.1', port: C.port, path: pr.url, method: pr.method, headers: Object.assign({}, pr.headers, { 'x-forwarded-proto': 'https', 'x-forwarded-for': '198.51.100.20', 'x-forwarded-host': 'console.example.com' }) }, ur => {
        ps.writeHead(ur.statusCode, ur.headers); ur.on('data', d => { ps.write(d); }); ur.on('end', () => ps.end());
      });
      up.on('error', () => { try { ps.writeHead(502); ps.end(); } catch (_) {} });
      pr.pipe(up);
    });
    await new Promise(rs => proxy.listen(proxyPort, '127.0.0.1', rs));
    const X = await login(proxyPort, tok3, { origin: 'https://console.example.com' });
    check('login through the proxy (Origin = the public host): Secure session', X.r.status === 200 && /; Secure/.test(cookieOf(X.r, 'capheos_session')));
    r = await req(proxyPort, 'POST', '/api/ops/access', { json: { sessionHours: 99 }, headers: { cookie: X.cookie, 'x-csrf-token': X.csrf, origin: 'https://console.example.com' } });
    check('a write through the proxy with the public Origin passes CSRF', r.status === 200, r.json);
    const sse = await new Promise((resolve, reject) => {
      const got = { headers: null, chunks: [], firstAt: 0 };
      const t0 = Date.now();
      const rq = http.request({ host: '127.0.0.1', port: proxyPort, path: '/api/events', headers: { cookie: X.cookie, accept: 'text/event-stream' } }, res => {
        got.headers = res.headers; got.status = res.statusCode;
        res.on('data', d => { if (!got.firstAt) got.firstAt = Date.now() - t0; got.chunks.push(String(d));
          if (got.chunks.length === 1) fs.writeFileSync(path.join(root, 'company', 'state', 'halt.json'), JSON.stringify({ mode: 'running', at: new Date().toISOString() }));
          if (/event: change/.test(got.chunks.join(''))) { rq.destroy(); resolve(got); } });
      });
      rq.on('error', e => { if (got.chunks.length) resolve(got); else reject(e); });
      setTimeout(() => { rq.destroy(); resolve(got); }, 8000);
      rq.end();
    });
    check('SSE through the proxy: no-buffering headers, the hello at once, a change event as it happens', sse.status === 200 && sse.headers['x-accel-buffering'] === 'no' && /no-transform/.test(sse.headers['cache-control']) && sse.firstAt < 2000 && /retry: 5000/.test(sse.chunks[0]) && /event: change/.test(sse.chunks.join('')),
      { status: sse.status, h: sse.headers, first: sse.firstAt, chunks: sse.chunks });
    r = await req(proxyPort, 'GET', '/api/chat/agent/attach?runId=none', { headers: { cookie: X.cookie } });
    check('the chat stream through the proxy: NDJSON, never buffered', r.status === 200 && r.headers['x-accel-buffering'] === 'no' && /console\.gone/.test(r.text), { s: r.status, h: r.headers });
    proxy.close();

    /* ---- bind address ---- */
    const D = await startConsole(root, { CONSOLE_HOST: '127.0.0.2', TEST_CONNECT: '127.0.0.2' }); procs.push(D);
    r = await req(D.port, 'GET', '/api/health', { host: '127.0.0.2' });
    let r2 = null; try { r2 = await req(D.port, 'GET', '/api/health'); } catch (e) { r2 = { status: 'refused' }; }
    check('CONSOLE_HOST sets the bind address (127.0.0.2 answers, 127.0.0.1 does not)', r.status === 200 && r2.status === 'refused', r2 && r2.status);
    D.stop();
    const E = await startConsole(root, { CONSOLE_HOST: '0.0.0.0' }); procs.push(E);   // company.json says 0.0.0.0 as well
    await sleep(200);
    check('beyond loopback the console warns at start (HTTPS, firewall, passphrase)', /WARNING the console listens on 0\.0\.0\.0/.test(E.out.text), E.out.text);
    E.stop();

    /* ---- no secret in an address or a log ---- */
    const logs = procs.map(p => p.out.text).join('\n');
    const secrets = [token, newTok, tok3, code, 'correct horse battery staple'];
    check('no token, passphrase or recovery code in any console output', secrets.every(s => !logs.includes(s) && !logs.includes(String(s).replace(/-/g, ''))), logs.slice(-400));
    check('the startup line names the login page and where the token is, never the token', /console: http:\/\/127\.0\.0\.1:\d+\/login \(sign in with/.test(logs));
    const u = spawnSync(process.execPath, [SERVER, '--url'], { encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: root }), timeout: 15000 });
    check('console --url to a pipe prints no token', u.status === 2 && !secrets.some(s => (u.stdout + u.stderr).includes(s)));
    const jobsDir = path.join(root, 'company', 'state', 'owner-ops');
    const opsText = fs.readFileSync(path.join(root, 'company', 'state', 'owner-ops.jsonl'), 'utf8') + (fs.existsSync(jobsDir) ? fs.readdirSync(jobsDir).map(f => fs.readFileSync(path.join(jobsDir, f), 'utf8')).join('') : '');
    check('no secret in the owner-ops record or the job logs', secrets.every(s => !opsText.includes(s)));

    /* ---- crash and restart ---- */
    const sport = await freePort();
    const sup = life.track(spawn(process.execPath, [path.join(REPO, 'scripts', 'supervise.js'), '--name', 'console', '--', process.execPath, SERVER, '--port', String(sport)],
      { env: Object.assign({}, process.env, { CAPHEOS_ROOT: root, STARNET_URL: 'http://127.0.0.1:1', CAPHEOS_SUPERVISOR: 'supervise' }), stdio: ['ignore', 'pipe', 'pipe'] }));
    let supOut = ''; sup.stdout.on('data', d => { supOut += d; }); sup.stderr.on('data', d => { supOut += d; });
    const childPid = () => { try { return Number(fs.readFileSync('/proc/' + sup.pid + '/task/' + sup.pid + '/children', 'utf8').trim().split(/\s+/)[0]) || null; } catch (_) { return null; } };
    const up1 = await until(async () => { try { return (await req(sport, 'GET', '/api/company', { headers: { cookie: S.cookie } })).status === 200; } catch (_) { return false; } }, 15000);
    const pid1 = childPid();
    if (pid1) process.kill(pid1, 'SIGKILL');
    await sleep(300);
    const up2 = await until(async () => { try { return (await req(sport, 'GET', '/api/company', { headers: { cookie: S.cookie } })).status === 200; } catch (_) { return false; } }, 15000);
    check('the console comes back after a crash (supervise.js), and the owner is still signed in', up1 && pid1 && up2 && childPid() !== pid1 && /exited \(SIGKILL\); starting again/.test(supOut), supOut.slice(-300));
    sup.kill('SIGTERM');
    const unit = fs.readFileSync(path.join(REPO, 'systemd', 'capheos-station-console.service.in'), 'utf8');
    check('under systemd the console unit restarts it too (Restart=always)', /^Restart=always$/m.test(unit));

    /* ---- linger ---- */
    const H2 = require(path.join(REPO, 'company', 'tools', 'lib', 'host.js'));
    const fake = path.join(root, 'fake-loginctl');
    fs.writeFileSync(fake, '#!/bin/sh\necho "$LINGER_ANSWER"\n', { mode: 0o755 });
    const env = v => Object.assign({}, process.env, { LOGINCTL: fake, LINGER_ANSWER: v, CAPHEOS_SUPERVISOR: 'systemd' });
    const off = H2.linger('robin', { env: env('no'), exists: () => false });
    check('linger off is detected, with the one admin command that fixes it (the units would stop at logout)', off.state === 'off' && /sudo loginctl enable-linger robin/.test(off.fix), off);
    check('linger on reads as on', H2.linger('robin', { env: env('yes'), exists: () => false }).state === 'on');
    check('in a container linger does not apply', H2.linger('robin', { env: Object.assign(env('no'), { CAPHEOS_SUPERVISOR: 'container' }) }).state === 'n/a');
    const setup = fs.readFileSync(path.join(REPO, 'scripts', 'setup-station.sh'), 'utf8');
    check('setup-station.sh turns linger on when it may, else says the admin must, once', /enable-linger "\$USER"/.test(setup) && /sudo loginctl enable-linger \$USER/.test(setup));
    const onb = fs.readFileSync(path.join(REPO, 'company', 'tools', 'onboard.js'), 'utf8');
    check('certification warns when linger is off', /lg\.state === 'off'/.test(onb) && /warnings/.test(onb));
  } catch (e) { check('ran to the end', false, e.stack); }
  finally { for (const p of procs) p.stop(); await sleep(200); fs.rmSync(root, { recursive: true, force: true }); }
  console.log(fails ? 'FAILED ' + fails + ' of ' + n : 'all ' + n + ' checks passed');
  process.exit(fails ? 1 : 0);
})();
