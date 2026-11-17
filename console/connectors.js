/* console/connectors.js — Settings › Connections and keys › <service> › Connect, server side. Docs: docs/CONNECTORS.md.
 *
 * Some services are reached through a CLI that needs the OWNER's own sign-in (Synpath: `synpath login` opens Google
 * sign-in; GitHub: `gh auth login --web`). This runs that CLI here, on the station machine, as the company user, so the
 * owner never needs a terminal, and the agents never hold the owner's browser session: the sign-in page opens in the
 * owner's own browser, wherever it is, and only the credential the CLI writes stays on the station.
 *
 *   - A connector is data: company/connectors/<id>.json {id, label, style (loopback | device-code | paste-code),
 *     loginCommand, postLogin, credentialPath, verify, redirectUri (loopback), ...}. See docs/CONNECTORS.md. Prefer a
 *     CLI's device-code or no-browser mode: the paste-the-address path below is a FALLBACK for loopback-only CLIs, and
 *     reading the sign-in address and code from a CLI's output can break when the CLI changes its wording.
 *   - The CLI runs with BROWSER (and xdg-open, open, www-browser on PATH, for that process only) set to a tiny shim that
 *     writes the address it was asked to open into a private file instead of opening a browser. The address is also read
 *     from the CLI's output. The owner's page gets "Sign in with <provider>" (that address, opened in the owner's own
 *     browser); for device-code also the code; for paste-code a field for the code.
 *   - loopback, owner's browser on another machine: the provider sends the browser to http://127.0.0.1:PORT/..., the
 *     OWNER's machine, which fails. The owner pastes the address from that page; it must be http on 127.0.0.1/localhost/
 *     [::1] at the expected port and redirect path, carrying the same state the sign-in address carried (refused
 *     otherwise), and only its path and query are replayed, by this
 *     process, as one GET to 127.0.0.1:PORT here. No other host is ever contacted, no redirect is followed.
 *     Same machine (the request comes from 127.0.0.1 with no forwarding header): the redirect just works.
 *   - Success: the postLogin commands, then every artefact must exist as a file with mode 0600, then the verify command
 *     must pass. Then: provenance rows (the owner's change, so locked-watch.js stays quiet; it watches each connector's
 *     artefacts as keys), company/state/connections.json (id, when, by the owner, artefact paths, never values) and a CEO
 *     handoff ("The owner connected Synpath").
 *   - One sign-in at a time per connector; the CLI (its whole process group) is killed after 10 minutes. The captured
 *     address and codes live in this process's memory only and go to the owner's page only; CLI output kept for the page
 *     is redacted (addresses, codes, key-like strings), and nothing here logs them.
 * Where the credential lives: under the company root, company/connections/<id>/ (0700), so one volume holds every
 * connection and a container rebuild keeps them. A connector sets its CLI's config location there through configEnv
 * ({"SYNPATH_CREDENTIALS_FILE": "{dir}/credentials.json"}, {"GH_CONFIG_DIR": "{dir}"}; {dir} is that folder); the same
 * variables must be in the environment of the crew's tools that read it (status: crewEnv). A CLI that cannot be
 * redirected keeps ~/ paths, and status says so (storage: 'home': not kept across a rebuild unless ~ is a volume).
 * What the credential is NOT kept from (G4, the owner's ruling: one Unix user for console, crew and station): the
 * file is 0600, never logged and never put into a prompt, but the crew's tools run as the same user and CAN read it.
 * Every status says so (isolation: 'same-user', crewCanRead). The hook for a future separate-user credential broker is
 * opts.broker (see BROKER below): when the console passes one, every CLI runs through it instead.
 * Pure helpers (checkCallback, redact, loadDeclarations, expectedPort, ...) are also used by the dev mock.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const STYLES = ['loopback', 'device-code', 'paste-code'];
const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const LOGIN_TIMEOUT_MS = 10 * 60e3;
const STEP_TIMEOUT_MS = 2 * 60e3;

/* ---------------- declarations ---------------- */
const isArgv = a => Array.isArray(a) && a.length > 0 && a.length <= 32 && a.every(x => typeof x === 'string' && x.length > 0 && x.length < 512 && !x.includes('\0'));
const okArtefact = a => typeof a === 'string' && a.length < 512 && !a.includes('\0') && !a.includes('*') && !a.split('/').includes('..') && (a.startsWith('~/') || (!a.startsWith('/') && !a.startsWith('~')));
const credPaths = d => (Array.isArray(d.credentialPath) ? d.credentialPath : [d.credentialPath]).filter(x => x !== undefined);
// a declaration, checked and normalised (credentialPath always a list); returns { decl } or { error }
function validate(d0, file) {
  const e = msg => ({ error: (file ? file + ': ' : '') + msg });
  if (!d0 || typeof d0 !== 'object' || Array.isArray(d0)) return e('not a JSON object');
  const d = Object.assign({}, d0);
  if (!ID.test(String(d.id || ''))) return e('id: lowercase letters, digits and -');
  if (file && path.basename(file, '.json') !== d.id) return e('the file name must be <id>.json');
  if (typeof d.label !== 'string' || !d.label.trim()) return e('label is required');
  if (!isArgv(d.loginCommand)) return e('loginCommand: an argv array of strings');
  if (d.postLogin !== undefined && !(Array.isArray(d.postLogin) && d.postLogin.every(isArgv))) return e('postLogin: a list of argv arrays');
  d.credentialPath = credPaths(d);
  if (!d.credentialPath.length || !d.credentialPath.every(okArtefact)) return e('credentialPath: a path (or list), "~/..." or relative to the company root, no "..", no wildcards');
  if (d.configEnv !== undefined && !(d.configEnv && typeof d.configEnv === 'object' && !Array.isArray(d.configEnv) && Object.entries(d.configEnv).every(([k, v]) => /^[A-Z_][A-Z0-9_]{0,63}$/.test(k) && !/^(PATH|HOME|BROWSER|GH_BROWSER|NODE_OPTIONS|LD_\w+)$/.test(k) && typeof v === 'string' && v.startsWith('{dir}') && !v.split('/').includes('..'))))
    return e('configEnv: {"VAR": "{dir}/..."}: where the CLI keeps its credential, under the connection\'s folder');
  if (d.configEnv && !d.credentialPath.every(a => a.startsWith('company/connections/' + d.id + '/'))) return e('with configEnv, credentialPath is under company/connections/' + d.id + '/');
  if (d.verify !== undefined && !isArgv(d.verify)) return e('verify: an argv array');
  if (d.logout !== undefined && !isArgv(d.logout)) return e('logout: an argv array');
  if (!STYLES.includes(d.style)) return e('style: one of ' + STYLES.join(', '));
  if (d.style === 'loopback') {
    let r = null; try { r = new URL(String(d.redirectUri || '').replace('{port}', '1')); } catch (_) {}
    if (!r || r.protocol !== 'http:' || !LOOPBACK_HOSTS.has(r.hostname) || r.search || r.hash) return e('redirectUri: the CLI\'s return address, http://127.0.0.1:{port}/<path> (or a fixed port)');
    if (String(d.redirectUri).includes('{port}') && !d.portParam && !d.redirectParam) return e('a {port} in redirectUri needs portParam or redirectParam (where the sign-in address names the port)');
  }
  if (d.style === 'device-code' && typeof d.codePattern !== 'string') return e('codePattern: a regular expression whose first group is the code');
  for (const k of ['codePattern', 'urlPattern']) if (d[k] !== undefined) { try { new RegExp(d[k]); } catch (x) { return e(k + ': ' + x.message); } }
  return { decl: d };
}
// every company/connectors/*.json (the folder the framework ships); bad ones are skipped with their reason
function loadDeclarations(dir) {
  const out = [], errors = [];
  let files = []; try { files = fs.readdirSync(dir).filter(f => /\.json$/.test(f)).sort(); } catch (_) { return { connectors: out, errors }; }
  for (const f of files) {
    let d; try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (x) { errors.push(f + ': bad JSON'); continue; }
    const v = validate(d, f); if (v.error) errors.push(v.error); else out.push(v.decl);
  }
  return { connectors: out, errors };
}

/* ---------------- pure helpers ---------------- */
/* What a pasted return address must match, from the declaration and the sign-in address the CLI produced: the port
 * (fixed in redirectUri, a query parameter of the sign-in address such as Synpath's cli_port, or the port of its
 * redirect_uri parameter), the redirect path, and the state the sign-in address carries (stateParam there; the provider
 * returns it as callbackStateParam, default "state"). Returns { port, path, host, state } or null. */
function expectation(d, url) {
  let u; try { u = new URL(url); } catch (_) { return null; }
  let port = null, rpath = null, host = null;
  const tpl = String(d.redirectUri || '');
  const fixed = /^http:\/\/[^/]+:(\d+)\//.exec(tpl);
  if (fixed) port = Number(fixed[1]);
  if (!port && d.portParam) { const n = Number(u.searchParams.get(d.portParam)); if (Number.isInteger(n) && n > 0 && n < 65536) port = n; }
  const rp = u.searchParams.get(d.redirectParam || 'redirect_uri');
  if (rp) { try { const x = new URL(rp); if (LOOPBACK_HOSTS.has(x.hostname) && x.port) { if (port && Number(x.port) !== port) return null; port = Number(x.port); rpath = x.pathname; host = x.hostname; } else return null; } catch (_) { return null; } }
  if (!rpath && tpl) { try { const x = new URL(tpl.replace('{port}', '1')); rpath = x.pathname; } catch (_) {} }
  if (!port) return null;
  const state = d.stateParam ? u.searchParams.get(d.stateParam) : u.searchParams.get('state');
  return { port, path: rpath, host, state: state || null, stateName: d.callbackStateParam || 'state', requireState: !!d.stateParam || !!state };
}
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
/* The address the owner pasted from the page the provider sent their browser to. Accepted only as http on a loopback
 * host at the expected port (and the declared callback path); returns { ok, port, pathAndQuery } or { ok:false, error }.
 * Nothing in the paste chooses where the request goes: the caller always connects to 127.0.0.1:<expected port>. */
function checkCallback(pasted, expect) {
  const s = String(pasted == null ? '' : pasted).trim();
  if (!s) return { ok: false, error: 'Paste the whole address from the page you landed on.' };
  if (s.length > 4096) return { ok: false, error: 'That is too long to be the sign-in address.' };
  let u; try { u = new URL(s); } catch (_) { return { ok: false, error: 'That is not a web address. Copy the whole address bar, starting with http://127.0.0.1' }; }
  if (u.protocol !== 'http:') return { ok: false, error: 'The address must start with http:// (the page your browser could not open), not ' + u.protocol.replace(':', '') + '.' };
  if (!LOOPBACK_HOSTS.has(u.hostname)) return { ok: false, error: 'That address is not for this sign-in: it must be on 127.0.0.1 (localhost). Copy the address of the page that failed to load after you signed in.' };
  if (u.username || u.password) return { ok: false, error: 'That address carries a user name; it is not the sign-in address.' };
  const port = Number(u.port || 80);
  if (!expect || !Number.isInteger(expect.port)) return { ok: false, error: 'This sign-in is not waiting for an address.' };
  if (port !== expect.port) return { ok: false, error: 'That address is from a different sign-in attempt (another port). Start again and use the newest sign-in link.' };
  if (expect.host && u.hostname !== expect.host) return { ok: false, error: 'That address does not match the return address this sign-in asked for (' + expect.host + ').' };
  if (expect.path && u.pathname !== expect.path) return { ok: false, error: 'That is not the sign-in return address (it should end in ' + expect.path + '?...).' };
  if (expect.requireState) {
    const got = u.searchParams.get(expect.stateName || 'state') || '';
    const a = Buffer.from(got), b = Buffer.from(String(expect.state || ''));
    if (!b.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, error: 'That address is from a different sign-in attempt (its state does not match). Start again and use the newest sign-in link.' };
  }
  return { ok: true, port, pathAndQuery: u.pathname + u.search, error: u.searchParams.get('error') || null };
}
// CLI output for the owner's page and for any error text: no addresses (they carry state and codes), no codes, no keys
function redact(text, extra) {
  let s = String(text == null ? '' : text);
  for (const x of extra || []) if (x && String(x).length >= 4) s = s.split(String(x)).join('[hidden]');
  return s.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, '[sign-in address]')
    .replace(/\b(spk|ghp|gho|ghu|ghs|ghr|github_pat|sk|pk|xox[a-z])[_-][A-Za-z0-9_.-]{8,}/g, '[hidden]')
    .replace(/\b(code|token|key|secret|password)(\s*[:=]\s*)\S+/gi, '$1$2[hidden]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[hidden]');
}
// the request is from a browser on this machine: loopback peer and no proxy header naming someone else
function sameMachine(req) {
  if (!req || !req.socket) return false;
  const a = String(req.socket.remoteAddress || '');
  const loop = a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  const fwd = String((req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers.forwarded)) || '').trim();
  return loop && !fwd;
}
const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/g;
function firstUrl(text, d) {
  const re = d && d.urlPattern ? new RegExp(d.urlPattern) : null;
  for (const m of String(text).match(URL_RE) || []) {
    const u = m.replace(/[).,;]+$/, '');
    let x; try { x = new URL(u); } catch (_) { continue; }
    if (LOOPBACK_HOSTS.has(x.hostname)) continue;   // the CLI's own listener, never a sign-in page
    if (re && !re.test(u)) continue;
    return u;
  }
  return null;
}

/* ---------------- the console part ---------------- */
module.exports = function connectors({ co, bad, HttpError, tool, owner, opts }) {
  opts = opts || {};
  const DIR = opts.dir || co.p('company', 'connectors');
  const HOME = path.resolve(opts.home || process.env.CONNECTORS_HOME || os.homedir());
  const STATE = opts.stateFile || co.p('company', 'state', 'connections.json');
  const TIMEOUT = opts.timeoutMs || Number(process.env.CONNECTORS_TIMEOUT_MS) || LOGIN_TIMEOUT_MS;
  const prov = () => { try { return opts.provenance || tool('provenance.js'); } catch (_) { return null; } };
  const sessions = new Map();   // id -> the current (or last) sign-in
  const verifyCache = new Map();

  const decls = () => loadDeclarations(DIR);
  const declOf = id => { const d = decls().connectors.find(c => c.id === id); if (!d) throw new HttpError(404, 'no connector "' + String(id).slice(0, 40) + '"'); return d; };
  const connDir = d => path.join(co.ROOT, 'company', 'connections', d.id);
  const confEnv = d => { const o = {}; for (const [k, v] of Object.entries(d.configEnv || {})) o[k] = connDir(d) + v.slice('{dir}'.length); return o; };
  const storageOf = d => d.credentialPath.every(a => a.startsWith('~/')) ? 'home' : 'company';
  const absOf = a => a.startsWith('~/') ? path.join(HOME, a.slice(2)) : path.join(co.ROOT, a);
  // the CLI: `deps.js run <bin> ...` when the company has deps.js (its own installs), else PATH; "node" is this node
  function resolveArgv(argv) {
    if (argv[0] === 'node') return [process.execPath].concat(argv.slice(1));
    if (argv[0].startsWith('/')) return argv.slice();
    const deps = path.join(co.ROOT, 'company', 'tools', 'deps.js');
    if (!opts.noDeps && fs.existsSync(deps)) return [process.execPath, deps, 'run'].concat(argv);
    return argv.slice();
  }
  const readState = () => { try { const j = JSON.parse(fs.readFileSync(STATE, 'utf8')); return j && typeof j === 'object' && j.connections ? j : { connections: {} }; } catch (_) { return { connections: {} }; } };
  function writeState(j) {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    const tmp = STATE + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(j, null, 1) + '\n'); fs.renameSync(tmp, STATE);
  }

  /* BROKER: the hook for a future separate-user credential broker: opts.broker, an object { spawn(argv, options) ->
   * ChildProcess, canRead(path) -> boolean } that runs each CLI as another user and keeps the credential out of this
   * user's reach. Only console/server.js passes it (never loaded from a file the crew could write). None exists today
   * (the owner's ruling: one user), so every CLI runs here as the company user and crewCanRead is true. */
  const BROKER = () => opts.broker || null;
  const doSpawn = (cmd, args, o) => { const b = BROKER(); return b && typeof b.spawn === 'function' ? b.spawn([cmd].concat(args), o) : spawn(cmd, args, o); };
  // can a crew tool (this same user) read the credential? With no broker: yes, and it is reported, never hidden
  function crewCanRead(d) {
    const b = BROKER(); if (b && typeof b.canRead === 'function') return d.credentialPath.some(a => b.canRead(absOf(a)));
    return d.credentialPath.some(a => { try { fs.accessSync(absOf(a), fs.constants.R_OK); return true; } catch (_) { return false; } });
  }
  /* artefacts: each must be a regular file, mode 0600 */
  function artefacts(d) {
    return d.credentialPath.map(a => {
      const f = absOf(a); let st = null; try { st = fs.lstatSync(f); } catch (_) {}
      const mode = st ? st.mode & 0o777 : null;
      return { path: a, exists: !!(st && st.isFile()), mode: mode == null ? null : '0' + mode.toString(8), private: mode === 0o600 };
    });
  }
  // a command with the connector's environment, its output captured (bounded); never through a shell
  function runStep(d, argv, env, timeoutMs) {
    return new Promise(resolve => {
      const a = resolveArgv(argv); let out = '';
      let child; try { child = doSpawn(a[0], a.slice(1), { cwd: HOME, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true }); }
      catch (e) { return resolve({ code: 127, out: String(e.message) }); }
      const add = c => { if (out.length < 65536) out += c; };
      child.stdout.on('data', add); child.stderr.on('data', add);
      const t = setTimeout(() => killGroup(child), timeoutMs || STEP_TIMEOUT_MS);
      child.on('error', e => { clearTimeout(t); resolve({ code: 127, out: out + String(e.message) }); });
      child.on('close', (code, sig) => { clearTimeout(t); resolve({ code: code == null ? (sig ? 128 : 1) : code, out }); });
    });
  }
  async function verify(d, env) {
    if (!d.verify) return { ok: true };
    const r = await runStep(d, d.verify, env || baseEnv(d), 60e3);
    return { ok: r.code === 0, code: r.code, out: redact(r.out).slice(-600) };
  }
  function baseEnv(d, shimDir) {
    if (d.configEnv) { fs.mkdirSync(connDir(d), { recursive: true, mode: 0o700 }); try { fs.chmodSync(connDir(d), 0o700); } catch (_) {} }
    const env = Object.assign({}, process.env, { HOME }, confEnv(d));
    if (shimDir) {
      const shim = path.join(shimDir, 'browser');
      Object.assign(env, { BROWSER: shim, GH_BROWSER: shim, PATH: shimDir + path.delimiter + (env.PATH || ''), CAPHEOS_BROWSER_FILE: path.join(shimDir, 'opened'), NO_COLOR: '1' });
      delete env.DISPLAY; delete env.WAYLAND_DISPLAY;   // never a real browser on the station
    }
    return env;
  }
  // the shim: every "open this address" lands in a private file (0700 folder, 0600 file) the console reads
  function makeShim() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capheos-connect-'));
    fs.chmodSync(dir, 0o700);
    const body = '#!/bin/sh\n# CaPheOS Connect: record the address instead of opening a browser (console/connectors.js)\numask 077\nfor a in "$@"; do case "$a" in http://*|https://*) printf \'%s\\n\' "$a" >> "$CAPHEOS_BROWSER_FILE";; esac; done\nexit 0\n';
    for (const n of ['browser', 'xdg-open', 'open', 'www-browser', 'sensible-browser']) fs.writeFileSync(path.join(dir, n), body, { mode: 0o700 });
    return dir;
  }
  function killGroup(child) {
    if (!child || child.exitCode !== null || child.killed && child.signalCode) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch (_) { try { child.kill('SIGTERM'); } catch (_) {} }
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {} }, 3000).unref();
  }

  /* ---------------- status ---------------- */
  async function statusOf(d, fresh) {
    const arts = artefacts(d);
    const rec = readState().connections[d.id] || null;
    const s = sessions.get(d.id);
    let state = 'not-connected', expired = null;
    if (arts.every(a => a.exists)) {
      const c = verifyCache.get(d.id);
      let v = c && !fresh && Date.now() - c.at < 60e3 ? c.v : null;
      if (!v) { v = await verify(d); verifyCache.set(d.id, { at: Date.now(), v }); }
      state = v.ok ? 'connected' : 'expired'; if (!v.ok) expired = d.expiredHint || 'The saved sign-in no longer works. Reconnect to sign in again.';
    }
    return { id: d.id, label: d.label, about: d.about || null, docs: d.docs || null, style: d.style, provider: d.provider || null,
      state, expiredHint: expired, artefacts: arts.map(a => ({ path: a.path, exists: a.exists, mode: a.mode })),
      connectedAt: rec && rec.connected ? rec.connectedAt : null, by: rec && rec.connected ? rec.by : null, outside: state !== 'not-connected' && !(rec && rec.connected),
      knownIssues: (d.knownIssues || []).map(k => ({ title: k.title, text: k.text })), serviceKey: d.serviceKey || null,
      signingIn: !!(s && !s.ended),
      storage: storageOf(d), crewEnv: d.configEnv ? Object.fromEntries(Object.entries(confEnv(d)).map(([k, v]) => [k, path.relative(co.ROOT, v).split(path.sep).join('/')])) : null,
      storageNote: storageOf(d) === 'home' ? d.label + '\'s program cannot be told where to keep its sign-in, so it stays in the home folder (' + d.credentialPath.join(', ') + '): in a container, it is lost on a rebuild unless the home folder is a volume.' : null,
      // G4: the honest answer, shown as it is (one Unix user runs the console, the crew and the station)
      isolation: BROKER() ? 'broker' : 'same-user', crewCanRead: arts.some(a => a.exists) ? crewCanRead(d) : null,
      promise: BROKER() ? 'Held by the credential broker under another user.' : 'Kept out of prompts and logs, not out of reach of the crew\'s tools: the file is owner-only (0600) for the one user the console, crew and station all run as.' };
  }
  async function list() {
    const { connectors: cs, errors } = decls();
    return { ok: true, connectors: await Promise.all(cs.map(d => statusOf(d))), errors };
  }

  /* ---------------- a sign-in ---------------- */
  function view(s, req) {
    if (!s) return { ok: true, session: null };
    const d = s.decl;
    return { ok: true, session: { id: s.id, connector: d.id, label: d.label, style: d.style, provider: d.provider || null,
      phase: s.phase, url: s.phase === 'sign-in' ? s.url : null, code: s.phase === 'sign-in' ? s.code : null,
      needs: s.phase !== 'sign-in' ? null : d.style === 'device-code' ? (s.code ? 'enter-code-there' : 'wait') : d.style === 'paste-code' ? 'paste-code' : 'loopback',
      sameMachine: req ? sameMachine(req) : s.sameMachine, port: s.expect ? s.expect.port : null,
      message: s.message, error: s.error, knownIssue: s.knownIssue, steps: s.steps.slice(), startedAt: s.startedAt, endsAt: s.endsAt, endedAt: s.endedAt || null,
      output: redact(s.out, [s.url, s.code]).split('\n').slice(-12).join('\n') } };
  }
  function issueFor(d, text) {
    for (const k of d.knownIssues || []) { try { if (k.match && new RegExp(k.match, 'i').test(String(text))) return { title: k.title, text: k.text }; } catch (_) {} }
    return null;
  }
  function end(s, phase, msg, err) {
    if (s.ended) return; s.ended = true; s.phase = phase; s.message = msg || null; s.error = err || null; s.endedAt = new Date().toISOString();
    clearTimeout(s.timer); clearInterval(s.poll); killGroup(s.child);
    try { fs.rmSync(s.shimDir, { recursive: true, force: true }); } catch (_) {}
    if (phase === 'failed' && !s.knownIssue) s.knownIssue = issueFor(s.decl, s.out + ' ' + (err || ''));
  }
  function capture(s) {
    if (s.url && (s.decl.style !== 'device-code' || s.code)) return;
    let opened = ''; try { opened = fs.readFileSync(path.join(s.shimDir, 'opened'), 'utf8'); } catch (_) {}
    const url = firstUrl(opened, s.decl) || firstUrl(s.out, s.decl);
    if (url && !s.url) {
      s.url = url;
      if (s.decl.style === 'loopback') { s.expect = expectation(s.decl, url); if (!s.expect) return end(s, 'failed', null, 'The sign-in program did not say which local return address it listens on (it may have changed its output; see docs/CONNECTORS.md).'); }
    }
    if (s.decl.style === 'device-code' && !s.code) { const m = new RegExp(s.decl.codePattern).exec(s.out); if (m) s.code = m[1] || m[0]; }
    if (s.url && (s.decl.style !== 'device-code' || s.code) && s.phase === 'starting') s.phase = 'sign-in';
  }
  function start(id, b, req) {
    const d = declOf(id);
    const cur = sessions.get(id);
    if (cur && !cur.ended) throw new HttpError(409, d.label + ' sign-in is already open. Finish it or cancel it first.', { code: 'busy' });
    const shimDir = makeShim();
    const env = baseEnv(d, shimDir);
    const s = { id: crypto.randomBytes(6).toString('hex'), decl: d, phase: 'starting', url: null, code: null, port: null, out: '', steps: [], message: null, error: null, knownIssue: null,
      startedAt: new Date().toISOString(), endsAt: new Date(Date.now() + TIMEOUT).toISOString(), shimDir, env, sameMachine: sameMachine(req), ended: false };
    const a = resolveArgv(d.loginCommand);
    try { s.child = doSpawn(a[0], a.slice(1), { cwd: HOME, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true }); }
    catch (e) { fs.rmSync(shimDir, { recursive: true, force: true }); bad('could not start ' + d.label + ' sign-in: ' + redact(e.message)); }
    sessions.set(id, s);
    const add = c => { if (s.out.length < 65536) s.out += c; capture(s); };
    s.child.stdout.on('data', add); s.child.stderr.on('data', add);
    s.child.stdin.on('error', () => {});
    s.child.on('error', e => end(s, 'failed', null, (e.code === 'ENOENT' ? d.label + '\'s program (' + d.loginCommand[0] + ') is not installed on the station.' : redact(e.message))));
    s.child.on('close', code => { if (s.ended) return; if (code === 0) finish(s).catch(e => end(s, 'failed', null, redact(e.message))); else end(s, 'failed', null, d.label + ' sign-in did not finish (the program stopped with exit ' + code + ').'); });
    s.poll = setInterval(() => capture(s), 200);
    s.timer = setTimeout(() => end(s, 'timed-out', null, 'The sign-in was not finished within ' + Math.round(TIMEOUT / 60000) + ' minutes, so it was stopped. Start again when you are ready.'), TIMEOUT);
    s.timer.unref && s.timer.unref();
    return view(s, req);
  }
  async function finish(s) {
    const d = s.decl; s.phase = 'finishing'; s.url = null; s.code = null;
    for (const argv of d.postLogin || []) {
      if (s.ended) return;
      const r = await runStep(d, argv, s.env);
      s.out += r.out; s.steps.push({ step: argv.slice(0, 3).join(' '), ok: r.code === 0 });
      if (r.code !== 0) return end(s, 'failed', null, 'Signed in, but "' + argv.slice(0, 3).join(' ') + '" failed (exit ' + r.code + '). ' + redact(r.out).trim().split('\n').slice(-1)[0]);
    }
    s.phase = 'verifying';
    const arts = artefacts(d);
    const missing = arts.filter(a => !a.exists), loose = arts.filter(a => a.exists && !a.private);
    if (missing.length) return end(s, 'failed', null, 'Signed in, but ' + missing.map(a => a.path).join(', ') + ' was not written.');
    if (loose.length) return end(s, 'failed', null, loose.map(a => a.path + ' is mode ' + a.mode).join(', ') + ': others on the station could read it. It must be 0600 (owner only).');
    const v = await verify(d, s.env); verifyCache.set(d.id, { at: Date.now(), v });
    if (!v.ok) return end(s, 'failed', null, 'Signed in, but the check (' + d.verify.slice(0, 3).join(' ') + ') did not pass.');
    if (s.ended) return;
    record(d, 'connected');
    end(s, 'connected', 'Connected. ' + d.label + ' is ready for the crew.');
  }
  // the owner's change: provenance per artefact (hash of the bytes now on disk), the connections record, the CEO's handoff
  function record(d, what) {
    const P = prov();
    for (const a of d.credentialPath) {
      const f = absOf(a);
      try { if (what === 'connected') { if (P) P.wrote(f, fs.readFileSync(f), 'console (owner connect ' + d.id + ')'); } else if (P) P.removed(f, 'console (owner disconnect ' + d.id + ')'); } catch (_) {}
    }
    const j = readState(); const prev = j.connections[d.id] || {};
    j.connections[d.id] = what === 'connected'
      ? { id: d.id, label: d.label, connected: true, connectedAt: new Date().toISOString(), by: 'owner', ownerName: owner(), artefacts: d.credentialPath.slice(), style: d.style }
      : Object.assign({}, prev, { id: d.id, label: d.label, connected: false, disconnectedAt: new Date().toISOString(), by: 'owner', ownerName: owner(), artefacts: d.credentialPath.slice() });
    writeState(j);
    tellCeo(d, what);
  }
  function tellCeo(d, what) {
    try {
      const ceo = co.ceo(); if (!ceo) return null;
      const kit = tool(path.join('lib', 'modkit.js'));
      const head = 'The owner ' + what + ' ' + d.label;
      return kit.appendHandoff(ceo, head, {
        What: head + ' in Settings › Connections and keys (signed in on the station; the credential is ' + d.credentialPath.join(', ') + ', owner-only).',
        Need: what === 'connected' ? 'If anyone was waiting for ' + d.label + ', tell them it is ready. Its program reads the credential itself; never print, copy or paste it. Then set Status to DONE.'
          : 'Anyone using ' + d.label + ' stops working until the owner connects it again; tell them. Then set Status to DONE.',
      }, 'Console (for ' + owner() + ')') ? co.nameOf(ceo) : null;
    } catch (_) { return null; }
  }
  // loopback, remote: replay the pasted return address to the CLI's own listener on this machine
  function callback(id, b) {
    const d = declOf(id); const s = sessions.get(id);
    if (!s || s.ended || s.phase !== 'sign-in' || d.style !== 'loopback') throw new HttpError(409, 'No ' + d.label + ' sign-in is waiting for an address. Start one with Connect.');
    const c = checkCallback(b && b.address, s.expect);
    if (!c.ok) bad(c.error);
    if (c.error) s.knownIssue = issueFor(d, c.error) || s.knownIssue;
    return new Promise(resolve => {
      const req = http.request({ host: '127.0.0.1', port: c.port, path: c.pathAndQuery, method: 'GET', headers: { host: '127.0.0.1:' + c.port }, timeout: 10000 }, res => {
        res.resume();
        res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300
          ? Object.assign(view(s), { accepted: true })
          : Object.assign(view(s), { accepted: false, error: c.error ? 'The provider refused the sign-in (' + String(c.error).slice(0, 40) + ').' : d.label + '\'s sign-in program did not accept that address. Copy the address of the newest attempt and try again.' })));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', () => resolve(Object.assign(view(s), { accepted: false, error: d.label + '\'s sign-in program is no longer listening. Start again.' })));
      req.end();
    });
  }
  // paste-code: the code the provider showed, written to the CLI's stdin
  function code(id, b) {
    const d = declOf(id); const s = sessions.get(id);
    if (!s || s.ended || s.phase !== 'sign-in' || d.style !== 'paste-code') throw new HttpError(409, 'No ' + d.label + ' sign-in is waiting for a code.');
    const v = String((b && b.code) || '').trim();
    if (!/^[\x21-\x7e]{1,1024}$/.test(v)) bad('Paste the code the sign-in page showed (no spaces).');
    s.child.stdin.write(v + '\n'); s.phase = 'finishing-login';
    setTimeout(() => { if (s.phase === 'finishing-login' && !s.ended) s.phase = 'sign-in'; }, 15000).unref();
    return view(s);
  }
  function cancel(id) { const d = declOf(id); const s = sessions.get(id); if (s && !s.ended) end(s, 'cancelled', 'Cancelled.'); return view(sessions.get(id)); }
  function session(id, req) { declOf(id); return view(sessions.get(id), req); }
  async function disconnect(id, b) {
    const d = declOf(id);
    if (!b || b.confirm !== true) throw new HttpError(400, 'Disconnecting removes ' + d.credentialPath.join(', ') + ' from the station. Confirm to go ahead.', { code: 'confirm', artefacts: d.credentialPath });
    const s = sessions.get(id); if (s && !s.ended) end(s, 'cancelled', 'Cancelled.');
    let loggedOut = null;
    if (d.logout && artefacts(d).some(a => a.exists)) { const r = await runStep(d, d.logout, baseEnv(d), 60e3); loggedOut = r.code === 0; }
    const removed = [];
    for (const a of d.credentialPath) { const f = absOf(a); try { fs.lstatSync(f); fs.rmSync(f, { force: true }); removed.push(a); } catch (_) {} }
    record(d, 'disconnected'); verifyCache.delete(id);
    return { ok: true, id, removed, loggedOut };
  }
  // the console is stopping: no CLI outlives it
  function stopAll() { for (const s of sessions.values()) if (!s.ended) end(s, 'cancelled', 'The console stopped.'); }

  return { list, start, session, callback, code, cancel, disconnect, status: async id => ({ ok: true, connector: await statusOf(declOf(id), true) }), stopAll, _sessions: sessions };
};
Object.assign(module.exports, { STYLES, validate, loadDeclarations, expectation, checkCallback, redact, sameMachine, firstUrl, LOGIN_TIMEOUT_MS });
