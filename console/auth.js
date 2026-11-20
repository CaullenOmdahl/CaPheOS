'use strict';
/* console/auth.js — signing the owner in to the console from a browser on another machine (docs/DEPLOY-SERVER.md).
 *
 *   const AUTH = require('./auth.js')({ co, tokenFile });
 *   AUTH.check(req)            -> { ok, via: 'header'|'session', session? }   who is calling
 *   AUTH.csrfOk(req, a)        -> true when a state-changing request may go on (always for the header; the session's
 *                                 CSRF token in x-csrf-token, and a same-site Origin, for a browser)
 *   AUTH.handle(req, res, url) -> true when it answered /login or /logout
 *   AUTH.routes                -> [method, regex, fn(m, q, body, req, res)] for /api/auth/*
 *
 * THE SECRETS. secrets/console-token (random, 0600) is the owner token; an optional passphrase the owner sets in
 * Settings › System is kept as an scrypt hash in secrets/console-passphrase (0600). Either one is typed into the login
 * form (POST /login): never in an address, never in a log line. GET /login?token=… is not accepted any more.
 * THE SESSION. A cookie capheos_session = v1.<expiry>.<nonce>.<mac>, mac = HMAC-SHA256(HMAC(token, 'console-session'),
 * 'v1.<expiry>.<nonce>'): HttpOnly, SameSite=Lax, Secure whenever the request came over HTTPS (directly, or from a
 * trusted proxy that says X-Forwarded-Proto: https, or console.secureCookies: true). Nothing is stored server side, so a
 * console restart keeps everyone signed in, and rotating the token ("sign out everywhere") ends every session at once.
 * Expiry: company.json console.sessionHours (default 168, at most 720).
 * CSRF. Every POST signed in by the cookie carries x-csrf-token = HMAC(key, 'csrf.' + nonce), which the page reads from
 * the capheos_csrf cookie (not HttpOnly; console/ui/js/csrf.js adds the header) or GET /api/auth/session. A request with
 * an Origin header from another site is refused too. The x-console-token header (scripts, tests) is not a browser
 * credential, so it needs no CSRF token: a web page cannot send that header to another origin without a CORS preflight,
 * and the console answers none.
 * RATE LIMIT. 5 failed sign-ins per client per 15 minutes, 30 for everyone together; then 429 with Retry-After, even
 * for the right secret. The client is the socket's address, or the X-Forwarded-For entry a trusted proxy added.
 * TRUSTED PROXY. company.json console.trustProxy: false (default) | true (a proxy on this machine: 127.0.0.1 / ::1) |
 * ["10.0.0.2", ...]. Only then are X-Forwarded-Proto / X-Forwarded-For / X-Forwarded-Host believed.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
const WINDOW_MS = 15 * 60e3, PER_CLIENT = 5, GLOBAL = 30;
const MIN_PASSPHRASE = 12;

module.exports = function makeAuth(deps) {
  const { co } = deps;
  const tokenFile = deps.tokenFile || path.join(co.SECRETS_DIR, 'console-token');
  const passFile = deps.passFile || path.join(co.SECRETS_DIR, 'console-passphrase');
  const now = deps.now || (() => Date.now());
  const cc = () => module.exports.settings(co);
  // Cookies are scoped by host, not port: two companies' consoles on one machine (or one tunnel) share a cookie jar, so
  // one shared name meant signing in to one console signed you out of the other. Each console names its cookies after
  // its company (company.json slug); a company with no slug keeps the old names.
  const SUFFIX = module.exports.cookieSuffix(co);
  const SESSION = 'capheos_session' + SUFFIX, CSRF = 'capheos_csrf' + SUFFIX;
  const recFile = deps.recFile || path.join(co.SECRETS_DIR, 'console-recovery');

  /* ---------- the token: read from its file (re-read when the file changes), created on first use ---------- */
  let cache = { mtime: -1, size: -1, token: null };
  function writeToken(t) {
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    const tmp = tokenFile + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, t + '\n', { mode: 0o600 }); try { fs.chmodSync(tmp, 0o600); } catch (_) {}
    fs.renameSync(tmp, tokenFile);
    cache = { mtime: -1, size: -1, token: null };
  }
  function token() {
    let st = null; try { st = fs.statSync(tokenFile); } catch (_) {}
    if (st && st.mtimeMs === cache.mtime && st.size === cache.size && cache.token) return cache.token;
    if (st) { const t = String(fs.readFileSync(tokenFile, 'utf8')).trim(); if (t) { cache = { mtime: st.mtimeMs, size: st.size, token: t }; return t; } }
    writeToken(crypto.randomBytes(24).toString('hex'));
    return token();
  }
  // CONSOLE_SESSION_SECRET (env, e.g. a container secret) is mixed in: changing it, or the token, ends every session
  const key = () => crypto.createHmac('sha256', token() + String(process.env.CONSOLE_SESSION_SECRET || '')).update('console-session').digest();
  const mac = (s) => crypto.createHmac('sha256', key()).update(s).digest('base64url');
  const same = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };

  /* ---------- who is on the other end ---------- */
  function trustedPeers() {
    const t = cc().trustProxy;
    if (t === true) return LOOPBACK;
    if (Array.isArray(t)) return t.map(String).flatMap(a => a.includes(':') ? [a] : [a, '::ffff:' + a]);
    return [];
  }
  const peerOf = req => String((req.socket && req.socket.remoteAddress) || '');
  const fromTrustedProxy = req => trustedPeers().includes(peerOf(req));
  const firstHeader = (req, h) => String(req.headers[h] || '').split(',')[0].trim();
  function clientIp(req) {
    if (!fromTrustedProxy(req)) return peerOf(req);
    const chain = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    const trusted = trustedPeers();
    for (let i = chain.length - 1; i >= 0; i--) if (!trusted.includes(chain[i])) return chain[i];
    return peerOf(req);
  }
  function isHttps(req) {
    if (req.socket && req.socket.encrypted) return true;
    return fromTrustedProxy(req) && firstHeader(req, 'x-forwarded-proto').toLowerCase() === 'https';
  }
  const secure = req => cc().secureCookies === true || isHttps(req);
  const isLoopbackPeer = req => LOOPBACK.includes(peerOf(req));
  function hostOf(req) { return (fromTrustedProxy(req) && firstHeader(req, 'x-forwarded-host')) || String(req.headers.host || ''); }

  /* ---------- sessions (stateless, signed) ---------- */
  const hours = () => { const n = Number(cc().sessionHours); return Number.isFinite(n) && n > 0 ? Math.min(n, 720) : 168; };
  function newSession() {
    const exp = Math.floor(now() / 1000) + Math.round(hours() * 3600);
    const nonce = crypto.randomBytes(16).toString('base64url');
    const body = 'v1.' + exp + '.' + nonce;
    return { value: body + '.' + mac(body), exp, nonce, csrf: csrfFor(nonce) };
  }
  const csrfFor = nonce => crypto.createHmac('sha256', key()).update('csrf.' + nonce).digest('base64url');
  function parseCookies(req) { const o = {}; for (const part of String(req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) { try { o[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch (_) {} } } return o; }
  function readSession(req) {
    const v = parseCookies(req)[SESSION]; if (!v) return null;
    const m = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{20,100})$/.exec(v); if (!m) return null;
    if (!same(m[3], mac('v1.' + m[1] + '.' + m[2]))) return null;
    if (Number(m[1]) * 1000 <= now()) return null;
    return { exp: Number(m[1]), nonce: m[2], csrf: csrfFor(m[2]) };
  }
  function cookieHeaders(req, s) {
    const flags = '; Path=/; SameSite=Lax' + (secure(req) ? '; Secure' : '');
    const age = s ? Math.max(0, s.exp - Math.floor(now() / 1000)) : 0;
    return [
      SESSION + '=' + (s ? s.value : '') + flags + '; HttpOnly; Max-Age=' + age,
      CSRF + '=' + (s ? s.csrf : '') + flags + '; Max-Age=' + age,
      'console_token=' + flags + '; HttpOnly; Max-Age=0',   // the old raw-token cookie: cleared
    ].concat(SUFFIX ? ['capheos_session=' + flags + '; HttpOnly; Max-Age=0', 'capheos_csrf=' + flags + '; Max-Age=0'] : []);   // the old shared names: cleared
  }
  function check(req) {
    const h = req.headers['x-console-token'];
    if (h) return same(h, token()) ? { ok: true, via: 'header' } : { ok: false };
    const s = readSession(req);
    return s ? { ok: true, via: 'session', session: s } : { ok: false };
  }
  function originOk(req) {
    const o = req.headers.origin; if (!o) return true;
    let u; try { u = new URL(String(o)); } catch (_) { return false; }
    const allowed = [String(req.headers.host || ''), hostOf(req)].filter(Boolean);
    if (cc().publicUrl) { try { allowed.push(new URL(String(cc().publicUrl)).host); } catch (_) {} }
    return allowed.includes(u.host);
  }
  function csrfOk(req, a) {
    if (!a || !a.ok) return false;
    if (a.via === 'header') return true;
    return originOk(req) && same(req.headers['x-csrf-token'], a.session.csrf);
  }

  /* ---------- the passphrase ---------- */
  function passphraseSet() { try { const j = JSON.parse(fs.readFileSync(passFile, 'utf8')); return !!(j && j.hash); } catch (_) { return false; } }
  function passphraseOk(p) {
    let j; try { j = JSON.parse(fs.readFileSync(passFile, 'utf8')); } catch (_) { return false; }
    if (!j || !j.hash || !j.salt) return false;
    const h = crypto.scryptSync(String(p), Buffer.from(j.salt, 'base64'), 32, { N: j.N || 16384, r: 8, p: 1 }).toString('base64');
    return same(h, j.hash);
  }
  function setPassphrase(p) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(p), salt, 32, { N: 16384, r: 8, p: 1 }).toString('base64');
    fs.mkdirSync(path.dirname(passFile), { recursive: true });
    const tmp = passFile + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, N: 16384, salt: salt.toString('base64'), hash, setAt: new Date(now()).toISOString() }) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, passFile);
  }
  function secretOk(s) { const v = String(s || ''); if (!v) return false; return same(v.trim(), token()) || (v.length >= MIN_PASSPHRASE && passphraseOk(v)); }

  /* ---------- the recovery code: one use, for an owner who lost both the token and the passphrase ----------
   * Made in Settings › System › Sign-in (or at first sign-in), shown once, kept only as an scrypt hash in
   * secrets/console-recovery. Typed into the login form it signs in, is used up, and the owner is asked to set a new
   * passphrase and make a new code. Format: four groups of five letters/digits (no 0/O/1/I). */
  const REC_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const normRec = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  function recoverySet() { try { const j = JSON.parse(fs.readFileSync(recFile, 'utf8')); return !!(j && j.hash); } catch (_) { return false; } }
  function newRecovery() {
    let c = ''; const b = crypto.randomBytes(20); for (let i = 0; i < 20; i++) c += REC_ALPHA[b[i] % REC_ALPHA.length];
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(c, salt, 32, { N: 16384, r: 8, p: 1 }).toString('base64');
    fs.mkdirSync(path.dirname(recFile), { recursive: true });
    const tmp = recFile + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, salt: salt.toString('base64'), hash, at: new Date(now()).toISOString() }) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, recFile);
    return c.match(/.{5}/g).join('-');
  }
  function useRecovery(code) {
    const c = normRec(code); if (c.length !== 20) return false;
    let j; try { j = JSON.parse(fs.readFileSync(recFile, 'utf8')); } catch (_) { return false; }
    if (!j || !j.hash) return false;
    const h = crypto.scryptSync(c, Buffer.from(j.salt, 'base64'), 32, { N: 16384, r: 8, p: 1 }).toString('base64');
    if (!same(h, j.hash)) return false;
    try { fs.unlinkSync(recFile); } catch (_) {}
    return true;
  }

  /* ---------- the sign-in rate limit ---------- */
  const fails = new Map(); let allFails = [];
  function prune(t) {
    allFails = allFails.filter(x => t - x < WINDOW_MS);
    for (const [k, v] of fails) { const left = v.filter(x => t - x < WINDOW_MS); if (left.length) fails.set(k, left); else fails.delete(k); }
  }
  function limited(ip) {
    const t = now(); prune(t);
    const mine = fails.get(ip) || [];
    if (mine.length >= PER_CLIENT) return Math.ceil((mine[0] + WINDOW_MS - t) / 1000);
    if (allFails.length >= GLOBAL) return Math.ceil((allFails[0] + WINDOW_MS - t) / 1000);
    return 0;
  }
  function failed(ip) { const t = now(); if (fails.size > 10000) fails.clear(); fails.set(ip, (fails.get(ip) || []).concat([t])); allFails.push(t); }

  /* ---------- /login and /logout ---------- */
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function loginPage(req, opts) {
    opts = opts || {};
    const name = (co.config && co.config.name) || 'Company';
    const plain = !isHttps(req) && !isLoopbackPeer(req);
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<meta name="referrer" content="same-origin"><title>Sign in · ' + esc(name) + '</title><style>' +
      ':root{--bg:#f6f3ee;--fg:#1d1b18;--muted:#6b665e;--card:#fff;--line:#ddd6cb;--accent:#7a4b2a;--warn:#9a5b00;--bad:#a32020}' +
      '@media (prefers-color-scheme:dark){:root{--bg:#171512;--fg:#efe9e1;--muted:#a59d92;--card:#221f1b;--line:#3a352f;--accent:#d49a6a;--warn:#e0a640;--bad:#ff7b7b}}' +
      'body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}' +
      'main{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px;max-width:400px;width:100%;box-sizing:border-box}' +
      'h1{font-size:20px;margin:0 0 4px}p{margin:8px 0}.muted{color:var(--muted);font-size:14px}label{display:block;font-weight:600;margin:18px 0 6px}' +
      'input{width:100%;box-sizing:border-box;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}' +
      'button{margin-top:14px;width:100%;font:inherit;font-weight:600;padding:10px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}' +
      '.err{color:var(--bad)}.warn{color:var(--warn);font-size:14px}</style></head><body><main>' +
      '<h1>' + esc(name) + '</h1><p class="muted">Owner console. Sign in to continue.</p>' +
      (opts.error ? '<p class="err" role="alert">' + esc(opts.error) + '</p>' : '') +
      (opts.notice ? '<p class="warn" role="status">' + esc(opts.notice) + '</p>' : '') +
      (plain ? '<p class="warn">This connection is not encrypted. Anyone on the network between you and the server can read what you type. Put the console behind HTTPS (docs/DEPLOY-SERVER.md).</p>' : '') +
      '<form method="post" action="/login" autocomplete="on"><label for="secret">Owner token, passphrase or recovery code</label>' +
      '<input id="secret" name="secret" type="password" autocomplete="current-password" required autofocus>' +
      (opts.next ? '<input type="hidden" name="next" value="' + esc(opts.next) + '">' : '') +
      '<button type="submit">Sign in</button></form>' +
      '<p class="muted">The token is in <code>secrets/console-token</code> on the server; a passphrase is the one you set in Settings › System › Sign-in. Lost both? Type your one-time recovery code, or ask whoever runs the server to reset the sign-in (docs/DEPLOY-SERVER.md, "Locked out").</p>' +
      '</main></body></html>';
  }
  function sendPage(res, status, html, extra) {
    res.writeHead(status, Object.assign({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'same-origin',
      'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" }, extra || {}));
    res.end(html);
  }
  const safeNext = n => { const s = String(n || ''); return /^\/(?!\/)[A-Za-z0-9._~\-\/?#=&%]*$/.test(s) && !s.startsWith('/login') ? s : '/'; };
  function readForm(req) {
    return new Promise(resolve => {
      let d = ''; req.on('data', c => { d += c; if (d.length > 8192) { d = ''; req.destroy(); } });
      req.on('end', () => {
        if (/json/i.test(String(req.headers['content-type'] || ''))) { try { return resolve(JSON.parse(d || '{}') || {}); } catch (_) { return resolve({}); } }
        const o = {}; for (const [k, v] of new URLSearchParams(d)) o[k] = v; resolve(o);
      });
      req.on('error', () => resolve({}));
    });
  }
  async function handle(req, res, url) {
    if (url.pathname === '/login') {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const legacy = url.searchParams.has('token');
        return sendPage(res, legacy ? 400 : 200, loginPage(req, { next: safeNext(url.searchParams.get('next')), notice: legacy ? 'Sign-in links that carry the token in the address are no longer accepted (an address ends up in browser history and logs). Type or paste the token below instead.' : null })), true;
      }
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'GET, POST' }); res.end(); return true; }
      const json = /json/i.test(String(req.headers['content-type'] || ''));
      const answer = (status, error, extra) => json ? (res.writeHead(status, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, extra || {})), res.end(JSON.stringify({ ok: false, error }))) : sendPage(res, status, loginPage(req, { error }), extra);
      if (!originOk(req)) { answer(403, 'This sign-in came from another site and was refused.'); return true; }
      const ip = clientIp(req);
      const wait = limited(ip);
      if (wait > 0) { await readForm(req); answer(429, 'Too many sign-in attempts. Try again in ' + Math.ceil(wait / 60) + ' minute(s).', { 'retry-after': String(wait) }); return true; }
      const form = await readForm(req);
      let recovered = false;
      if (!secretOk(form.secret)) {
        if (/^[A-Za-z0-9]{5}(-?[A-Za-z0-9]{5}){3}$/.test(String(form.secret || '').trim()) && useRecovery(form.secret)) recovered = true;
        else { failed(ip); answer(401, 'That is not the owner token, passphrase or recovery code.'); return true; }
      }
      fails.delete(ip);
      if (recovered) { record('signed in with the one-time recovery code (now used up)'); form.next = '/#/settings/system/signin'; }
      const s = newSession();
      if (json) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'set-cookie': cookieHeaders(req, s) }); res.end(JSON.stringify({ ok: true, expiresAt: new Date(s.exp * 1000).toISOString(), csrf: s.csrf })); return true; }
      res.writeHead(303, { location: safeNext(form.next), 'set-cookie': cookieHeaders(req, s), 'cache-control': 'no-store' }); res.end();
      return true;
    }
    if (url.pathname === '/logout') {
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return true; }
      const a = check(req);
      if (a.ok && a.via === 'session' && !csrfOk(req, a)) { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('refused: missing CSRF token'); return true; }
      res.writeHead(303, { location: '/login', 'set-cookie': cookieHeaders(req, null), 'cache-control': 'no-store' }); res.end();
      return true;
    }
    return false;
  }

  /* ---------- /api/auth/* (behind the owner check and CSRF like every /api POST) ---------- */
  function record(what) {
    try {
      const f = co.p('company', 'work', 'decisions.md');
      if (!fs.existsSync(f)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, '# Decisions\n\n'); }
      const lp = co.localParts(new Date(now())); const owner = (co.config.owner && co.config.owner.name) || 'Owner';
      const line = '- ' + lp.date + ' ' + lp.time + ' ' + owner + ' (owner) ' + what + ' (console)\n';
      fs.appendFileSync(f, line);
      try { require(co.p('company', 'tools', 'provenance.js')).appended(f, line, 'console (owner)'); } catch (_) {}
    } catch (_) {}
    if (deps.record) try { deps.record(what); } catch (_) {}
  }
  function bad(msg, status) { if (deps.HttpError) throw new deps.HttpError(status || 400, msg); const e = new Error(msg); e.status = status || 400; throw e; }
  const routes = [
    ['GET', /^\/api\/auth\/session$/, (m, q, b, req) => {
      const a = check(req);
      return { ok: true, via: a.via, expiresAt: a.session ? new Date(a.session.exp * 1000).toISOString() : null, csrf: a.session ? a.session.csrf : null,
        passphraseSet: passphraseSet(), recoverySet: recoverySet(), https: isHttps(req), secureCookies: secure(req), trustedProxy: fromTrustedProxy(req), sessionHours: hours() };
    }],
    ['POST', /^\/api\/auth\/logout$/, (m, q, b, req, res) => { res.setHeader('set-cookie', cookieHeaders(req, null)); return { ok: true, signedOut: true }; }],
    ['POST', /^\/api\/auth\/rotate$/, (m, q, b, req, res) => {
      writeToken(crypto.randomBytes(24).toString('hex'));
      const s = newSession();   // under the new key: this browser stays signed in, every other session is over
      res.setHeader('set-cookie', cookieHeaders(req, s));
      record('rotated the console token: every other browser and device is signed out');
      return { ok: true, rotated: true, token: token(), csrf: s.csrf, note: 'Every other session is signed out. Keep the new token somewhere safe; it is shown once.' };
    }],
    ['POST', /^\/api\/auth\/passphrase$/, (m, q, b) => {
      if (b.clear === true) { try { fs.unlinkSync(passFile); } catch (_) {} record('removed the console sign-in passphrase'); return { ok: true, passphraseSet: false }; }
      const p = String(b.passphrase || '');
      if (p.length < MIN_PASSPHRASE) bad('a passphrase is at least ' + MIN_PASSPHRASE + ' characters');
      if (p.length > 512) bad('a passphrase is at most 512 characters');
      if (passphraseSet() && !secretOk(b.current)) bad('type the current passphrase (or the owner token) to change it', 403);
      setPassphrase(p); record('set a new console sign-in passphrase');
      return { ok: true, passphraseSet: true };
    }],
    ['POST', /^\/api\/auth\/recovery-code$/, () => {
      const code = newRecovery(); record('made a new one-time sign-in recovery code (the old one, if any, no longer works)');
      return { ok: true, code, note: 'Shown once. Write it down or keep it in a password manager: it signs you in once if you lose the token and the passphrase.' };
    }],
  ];

  return { token, writeToken, check, csrfOk, handle, routes, clientIp, isHttps, secure, newSession, cookieHeaders, readSession, loginPage, passphraseSet, recoverySet, newRecovery, useRecovery, LOOPBACK, _limited: limited };
};

/* ---------- settings: company.json "console", with env overrides (a container sets these) ----------
 *   CONSOLE_HOST, CONSOLE_PORT, CONSOLE_TRUST_PROXY ("true", "false" or a comma list of addresses),
 *   CONSOLE_SECURE_COOKIES ("true"), CONSOLE_SESSION_HOURS, CONSOLE_PUBLIC_URL, CONSOLE_SESSION_SECRET (mixed into the key). */
module.exports.settings = function settings(co) {
  const c = Object.assign({}, (co.config && co.config.console) || {}); const e = process.env;
  if (e.CONSOLE_HOST) c.host = e.CONSOLE_HOST;
  if (e.CONSOLE_TRUST_PROXY != null && e.CONSOLE_TRUST_PROXY !== '') c.trustProxy = e.CONSOLE_TRUST_PROXY === 'true' ? true : e.CONSOLE_TRUST_PROXY === 'false' ? false : e.CONSOLE_TRUST_PROXY.split(',').map(s => s.trim()).filter(Boolean);
  if (e.CONSOLE_SECURE_COOKIES) c.secureCookies = e.CONSOLE_SECURE_COOKIES === 'true';
  if (e.CONSOLE_SESSION_HOURS) c.sessionHours = Number(e.CONSOLE_SESSION_HOURS);
  if (e.CONSOLE_PUBLIC_URL) c.publicUrl = e.CONSOLE_PUBLIC_URL;
  return c;
};

/* the per-company cookie suffix: '_' + the company slug (letters, digits, dashes), or '' with no slug */
module.exports.cookieSuffix = co => { const sl = String((co && co.config && co.config.slug) || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40); return sl ? '_' + sl : ''; };
module.exports.cookieNames = co => { const x = module.exports.cookieSuffix(co); return { session: 'capheos_session' + x, csrf: 'capheos_csrf' + x }; };

/* ---------- bind address helpers (console/server.js listenConfig and Settings › System) ---------- */
module.exports.isLoopbackHost = h => /^(127\.\d+\.\d+\.\d+|::1|localhost)$/i.test(String(h || ''));
module.exports.bindWarning = h => module.exports.isLoopbackHost(h) ? null
  : 'the console listens on ' + h + ', not only on this machine: anyone who can reach that address gets the sign-in page. ' +
    'Keep it behind HTTPS (a reverse proxy, docs/DEPLOY-SERVER.md) and a firewall, and set a passphrase.';
