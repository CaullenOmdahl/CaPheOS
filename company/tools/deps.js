#!/usr/bin/env node
/* deps.js — the one sanctioned way for the crew to add a package (a Python or Node library or CLI) to the company.
 *
 *   node company/tools/deps.js add <python|node> <package>[==<version>] --why "..." --by <seat>
 *   node company/tools/deps.js remove <package> [--ecosystem python|node] --by <seat>
 *   node company/tools/deps.js adopt <python|node> <package>==<version> --by <seat> --why "..."   an ad hoc install (pipx,
 *        pip --user, npm -g) made the company's: added through deps.js like `add`, and the duty stops reporting it
 *   node company/tools/deps.js settle <package> --by <risk seat> --why "..."   an ad hoc install removed or not needed
 *   node company/tools/deps.js list [--json]
 *   node company/tools/deps.js verify [--rebuild]      env matches the lock; rebuild it from the lock when missing or wrong
 *   node company/tools/deps.js --duty                  read-only: the same check, for the dispatcher (docs/DUTIES.md)
 *   node company/tools/deps.js run <bin> [args...]     run an installed CLI from the company environment
 *   node company/tools/deps.js approve <licence|age|scripts|typo|registry> <ecosystem> <package>[==<version>]|<registry> --by <risk seat> --why "..."
 *   node company/tools/deps.js selftest
 * Exit: 0 done, 1 error, 2 usage, 3 refused (needs an approval, or self-governance waits for the owner).
 *
 * WHERE THINGS LIVE (all under the company root, so a server or a container keeps them on one volume):
 *   company/state/deps.json             the manifest: every package (direct and transitive) with version, hashes, licence,
 *                                       homepage, maintainers, published date, added by, why, when; the risk approvals;
 *                                       pending owner questions; the lock digests. Written only by this tool.
 *   company/state/deps/python.lock      pip requirements, every line `name==version --hash=sha256:...`
 *   company/state/deps/node/package.json + package-lock.json   npm's own lock (integrity sha512 per package)
 *   company/env/python -> python-<gen>  the venv (a generation folder behind a symlink)       gitignored, never backed up
 *   company/env/node   -> node-<gen>    package.json + lock + node_modules                    gitignored, never backed up
 *   company/env/bin    -> bin-<gen>     links to the CLIs; scripts/setup-station.sh puts it on the station's PATH
 *   company/env/{home,tmp,cache}        HOME, TMPDIR and caches pip/npm see: nothing is written outside the company tree
 * Locks and manifest are backed up (company/state); environments are not: `verify` rebuilds them from the lock.
 *
 * INTEGRITY. Hashes come from the registry BEFORE install (PyPI's JSON digests for every file of the version; npm's
 * packument integrity), never from what was downloaded. pip installs with --require-hashes --no-deps from the lock; npm
 * installs with `npm ci` from the lock. The first install is checked like every later one.
 * NO INSTALL SCRIPTS. pip runs with --only-binary :all: (a wheel runs no code at install); npm with --ignore-scripts.
 * A package that needs a build or install script (an sdist-only Python package; an npm package with pre/post/install
 * or a binding.gyp) is refused, naming it, unless the risk seat put it on the scripts allow-list (`approve scripts`).
 * ONLY THIS TOOL WRITES the manifest and the locks: every write is recorded with provenance.js and locked-watch.js holds
 * them (class A). verify and add refuse a lock or manifest whose bytes are not this tool's last recorded write, and
 * tell the risk seat.
 * TRANSACTIONS. A change builds a NEW generation beside the current one, installs and checks it, and only then swaps the
 * symlink (rename, atomic). The previous generation is kept for rollback; an interrupted install leaves the current env
 * running and the lock unchanged. A lock file under company/env/.deps.lock serialises changes.
 *
 * CHECKS before anything installs, over the whole resolved (transitive) tree:
 *   licence   permissive (MIT, BSD, Apache-2.0, ISC, MPL-2.0, PSF, Unlicense, CC0, Zlib, ...) passes; GPL/LGPL and the
 *             like, and anything unknown, need the risk seat's approval; AGPL and SSPL (network copyleft: a commercial
 *             decision for a server product) need the OWNER (an owner question with an Approve button).
 *   age       a version published less than policy.minAgeDays (default 7) days ago needs the risk seat's approval, except
 *             the exact first fixed release of an open P0 security finding (security-watch.js fastTrack; logged age-waived).
 *   typo      a name one or two edits from a popular package (reqeusts, lodahs) needs the risk seat's approval.
 *   scripts   above. yanked versions are refused.
 *   registry  only pypi.org/files.pythonhosted.org and registry.npmjs.org (REGISTRIES below). Any other registry (the
 *             selftest's loopback fake) needs the risk seat's approval. Network: each registry host must pass the
 *             external gate (category network): on the company allowlist, or a standing clearance row the CEO records
 *             (docs/DEPS.md). pip/npm children get a scrubbed environment: no secrets, no station token, no provider key.
 * GOVERNANCE (company/state/governance.json category `deps`, default notify): notify = install, then a one-line FYI to the
 * risk seat; approve = an owner question with an Approve button (lib/governance.js decide); once answered yes, the
 * next `verify` (or the same add) installs it, and the duty wakes the asker. auto = install, nothing else.
 * System packages (apt, dnf, brew...) are refused: "needs the owner: system packages install on the host"; an owner
 * question says in plain words what is needed. The ECOSYSTEMS table is the plug-in point for a later container-only
 * `system` ecosystem that shares the manifest, lock, licence, governance and transaction code.
 *
 * Owner of this tool: the tools seat. Policy and approvals: the risk seat. Docs: docs/DEPS.md.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const cp = require('child_process');
const co = require('./lib/company');

const ROOT = co.ROOT;
const P = (...a) => path.join(ROOT, ...a);
const F = {
  manifest: P('company', 'state', 'deps.json'),
  stateDir: P('company', 'state', 'deps'),
  pyLock: P('company', 'state', 'deps', 'python.lock'),
  nodePkg: P('company', 'state', 'deps', 'node', 'package.json'),
  nodeLock: P('company', 'state', 'deps', 'node', 'package-lock.json'),
  env: P('company', 'env'),
  bin: P('company', 'env', 'bin'),
  home: P('company', 'env', 'home'), tmp: P('company', 'env', 'tmp'), cache: P('company', 'env', 'cache'),
  lock: P('company', 'env', '.deps.lock'),
  log: P('company', 'work', 'deps-log.jsonl'),
  justification: P('company', 'work', 'security', 'deps-registries.md'),
  inbox: P('company', 'pm-inbox.jsonl'),
};
const rel = f => path.relative(ROOT, f).split(path.sep).join('/');
const sha256 = b => 'sha256:' + crypto.createHash('sha256').update(b).digest('hex');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } };
const nowIso = () => new Date().toISOString();
const DAY = 86400000;

class Refusal extends Error { constructor(msg, code) { super(msg); this.code = code || 3; } }
class Usage extends Error { constructor(msg) { super(msg); this.code = 2; } }

/* ---------------- registries: the tool-level allowlist ---------------- */
const REGISTRIES = {
  python: { id: 'pypi', hosts: ['pypi.org', 'files.pythonhosted.org'], json: 'https://pypi.org/pypi', index: 'https://pypi.org/simple' },
  node: { id: 'npmjs', hosts: ['registry.npmjs.org'], npm: 'https://registry.npmjs.org/' },
};
// DEPS_REGISTRY_URL: a loopback fake (the selftest). It is a NEW registry: it needs the risk seat's `approve registry`,
// and every package it supplied carries registry "loopback" in the manifest.
function registry(eco) {
  const u = process.env.DEPS_REGISTRY_URL;
  if (!u) return Object.assign({ local: false }, REGISTRIES[eco]);
  const m = /^http:\/\/(127\.0\.0\.1|localhost):(\d{2,5})\/?$/.exec(u);
  if (!m) throw new Usage('DEPS_REGISTRY_URL must be a loopback http://127.0.0.1:<port> fake registry');
  const base = u.replace(/\/+$/, '');
  return { id: 'loopback', local: true, hosts: [m[1] + ':' + m[2]], json: base + '/pypi', index: base + '/simple', npm: base + '/npm/' };
}

/* ---------------- seats ---------------- */
function seatOf(by) {
  const b = String(by || '').trim(); if (!b) return null;
  const lb = b.toLowerCase();
  const ownerName = String((co.config.owner && co.config.owner.name) || '').toLowerCase();
  if (lb === 'owner' || (ownerName && lb === ownerName)) return { id: 'owner', name: co.config.owner.name || 'Owner', owner: true };
  const crew = co.crew();
  for (const [id, s] of Object.entries(crew)) if (id.toLowerCase() === lb || String(s.name || '').toLowerCase() === lb) return Object.assign({ id }, s);
  return null;
}
function riskSeat() { const id = co.seatFor('risk'); const s = co.crew()[id]; return s ? Object.assign({ id }, s) : null; }
function needSeat(by) { const s = seatOf(by); if (!s) throw new Usage('--by must name a crew seat (company/tools/loops.json) or the owner; got "' + (by || '') + '"'); return s; }

/* ---------------- recorded writes (provenance) and the tamper check ---------------- */
function prov() { return require('./provenance.js'); }
function writeTracked(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text); fs.renameSync(tmp, file);
  try { prov().wrote(file, text, 'deps.js'); } catch (_) {}
}
function lastRecorded() {
  const out = {};
  const f = path.join(path.resolve(process.env.PROVENANCE_ROOT || ROOT), 'company', 'state', 'locked', 'provenance.jsonl');
  let lines = []; try { lines = require('./lib/bounded').tailLines(f, 20000, { maxBytes: 32 << 20 }); } catch (_) {}
  for (const l of lines) { let r; try { r = JSON.parse(l); } catch (_) { continue; } if (r && r.kind === 'write' && String(r.writer || '').split(' ')[0] === 'deps.js') out[r.file] = r; }
  return out;
}
const TRACKED = () => [F.manifest, F.pyLock, F.nodePkg, F.nodeLock];
// files whose bytes are not deps.js's last recorded write (edited by hand, or by anyone else)
function tampered() {
  const rec = lastRecorded(); const bad = [];
  for (const f of TRACKED()) {
    const buf = (() => { try { return fs.readFileSync(f); } catch (_) { return null; } })();
    const r = rec[rel(f)];
    if (buf === null) { if (r && r.bytes > 0) bad.push(rel(f) + ' (deleted)'); continue; }
    if (!r || r.sha256 !== sha256(buf)) bad.push(rel(f));
  }
  return bad;
}

/* ---------------- manifest ---------------- */
const MANIFEST_DOC = 'The company\'s dependencies (docs/DEPS.md). Written only by company/tools/deps.js; locked-watch.js puts back any other edit.';
function load() {
  const m = readJson(F.manifest, null) || {};
  return Object.assign({ _doc: MANIFEST_DOC, version: 1, policy: { minAgeDays: 7 }, packages: {}, approvals: [], pending: {}, env: {}, locks: {} }, m);
}
function save(m) { m._doc = MANIFEST_DOC; writeTracked(F.manifest, JSON.stringify(m, null, 1) + '\n'); }
const key = (eco, name) => eco + ':' + name;
function logRow(row) { try { fs.mkdirSync(path.dirname(F.log), { recursive: true }); fs.appendFileSync(F.log, JSON.stringify(Object.assign({ at: nowIso() }, row)) + '\n'); } catch (_) {} }

/* ---------------- licence ---------------- */
const ALLOW_RE = [/\bmit\b|\bexpat\b/i, /\bbsd\b|0bsd/i, /apache/i, /\bisc\b/i, /mpl[- ]?2|mozilla public license,? (v(ersion)? ?)?2/i, /python software foundation|\bpsf\b|python-2\.0/i,
  /unlicense/i, /\bcc0\b|public domain/i, /\bzlib\b/i, /blueoak/i, /\bhpnd\b/i, /artistic[- ]2/i, /\bbsl-1\.0\b|boost software/i, /\bwtfpl\b/i, /\bupl\b/i, /postgresql/i, /\bx11\b/i];
const OWNER_RE = /\bagpl|affero|\bsspl\b|server side public/i;
const RISK_RE = /\b(?:l?gpl|gnu|eupl|cddl|epl|cc-by-nc|cc-by-sa|osl|commons clause|busl|business source|proprietary|commercial|elastic license|polyform)/i;
/* classify(raw) -> { id, cls: 'allow' | 'risk' | 'owner' } ; an SPDX OR takes the best alternative, AND the worst */
function classifyLicence(raw) {
  const s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!s || /^(unknown|none|unlicensed|see license|other\/proprietary|noassertion)$/i.test(s)) return { id: s || 'unknown', cls: 'risk' };
  const rank = { allow: 0, risk: 1, owner: 2 };
  const one = t => OWNER_RE.test(t) ? 'owner' : RISK_RE.test(t) ? 'risk' : ALLOW_RE.some(r => r.test(t)) ? 'allow' : 'risk';
  const ors = s.replace(/[()]/g, ' ').split(/\s+OR\s+|\s*\/\s*|\s*;\s*/i);
  let best = 'owner';
  for (const alt of ors) { const worst = alt.split(/\s+AND\s+/i).map(one).sort((a, b) => rank[b] - rank[a])[0]; if (rank[worst] < rank[best]) best = worst; }
  return { id: s, cls: best };
}
function pyLicenceText(info) {
  if (!info) return '';
  if (info.license_expression) return info.license_expression;
  const cls = (info.classifiers || info.classifier || []).filter(c => /^License ::/.test(c)).map(c => c.split('::').pop().trim()).filter(c => c !== 'OSI Approved');
  if (cls.length) return cls.join(' OR ');
  const l = String(info.license || '').trim();
  return l.split('\n')[0].slice(0, 120);
}

/* ---------------- typosquat guard ---------------- */
const POPULAR = {
  python: ['requests', 'numpy', 'pandas', 'urllib3', 'setuptools', 'boto3', 'botocore', 'django', 'flask', 'pyyaml', 'six', 'certifi', 'idna', 'charset-normalizer', 'cryptography', 'wheel', 'click', 'jinja2', 'pytest', 'scipy', 'matplotlib', 'pillow', 'sqlalchemy', 'pydantic', 'fastapi', 'httpx', 'aiohttp', 'beautifulsoup4', 'selenium', 'tensorflow', 'torch', 'scikit-learn', 'openai', 'anthropic', 'colorama', 'python-dateutil', 'pytz', 'rich', 'tqdm', 'ccxt', 'websockets', 'psycopg2', 'redis', 'lxml', 'playwright'],
  node: ['lodash', 'react', 'express', 'axios', 'chalk', 'commander', 'debug', 'moment', 'request', 'typescript', 'webpack', 'vue', 'next', 'eslint', 'prettier', 'jest', 'uuid', 'dotenv', 'yargs', 'async', 'underscore', 'jquery', 'mongoose', 'socket.io', 'cross-env', 'nodemon', 'ws', 'minimist', 'semver', 'glob', 'rimraf', 'fs-extra', 'inquirer', 'playwright', 'puppeteer', 'esbuild', 'vite', 'react-dom', 'electron'],
};
function distance(a, b) {   // optimal string alignment (Damerau-Levenshtein with adjacent swaps)
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i].concat(new Array(b.length).fill(0)));
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    const c = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
function typoOf(eco, name) {
  const n = String(name).toLowerCase().replace(/[-_.]+/g, '-'); const list = POPULAR[eco] || [];
  if (list.includes(n)) return null;
  for (const p of list) { const lim = p.length >= 10 ? 2 : p.length >= 4 ? 1 : 0; if (lim && Math.abs(p.length - n.length) <= lim && distance(n, p) <= lim) return p; }
  return null;
}

/* ---------------- scrubbed child environment ---------------- */
const PASS = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS'];
function childEnv(extra) {
  const { SECRET_NAME } = require('./lib/duty-env');
  const env = {};
  for (const k of PASS) if (process.env[k] && !SECRET_NAME.test(k)) env[k] = process.env[k];
  if (!env.PATH) env.PATH = '/usr/local/bin:/usr/bin:/bin';
  for (const d of [F.home, F.tmp, F.cache]) fs.mkdirSync(d, { recursive: true });
  Object.assign(env, { HOME: F.home, TMPDIR: F.tmp, XDG_CACHE_HOME: F.cache, XDG_CONFIG_HOME: path.join(F.home, '.config'), XDG_DATA_HOME: path.join(F.home, '.local', 'share') });
  return Object.assign(env, extra || {});
}
function run(cmd, args, o) {
  o = o || {};
  const r = cp.spawnSync(cmd, args, { encoding: 'utf8', env: o.env || childEnv(), cwd: o.cwd || F.env, timeout: o.timeout || 900000, maxBuffer: 64 << 20 });
  if (o.must !== false && r.status !== 0) {
    const tail = String((r.stderr || '') + (r.stdout || '') || (r.error && r.error.message) || '').trim().split('\n').slice(-8).join('\n');
    throw new Refusal((o.what || cmd) + ' failed (exit ' + r.status + '): ' + tail, 1);
  }
  return r;
}
function fetchJson(url, reg) {
  const r = run('curl', ['-fsSL', '--max-time', '30', '--retry', '2', url], { env: childEnv(), must: false, timeout: 90000 });
  if (r.status !== 0) { if (r.status === 22) return null; throw new Refusal('could not reach the registry (' + (reg.local ? 'loopback' : reg.hosts[0]) + '): ' + String(r.stderr || r.error || '').trim().slice(0, 200), 1); }
  try { return JSON.parse(r.stdout); } catch (_) { throw new Refusal('the registry answered something that is not JSON for ' + url, 1); }
}

/* ---------------- the network gate ---------------- */
function gateNet(reg, seat) {
  if (reg.local) return;
  const gate = require('./external-gate.js');
  for (const h of reg.hosts) {
    const r = gate.check({ category: 'network', target: 'https://' + h + '/', agent: seat.owner ? 'owner' : seat.id, note: 'deps.js registry ' + reg.id });
    if (r.allow) continue;
    askForRegistryRow();
    throw new Refusal('the registry host ' + h + ' is not cleared by the external gate (' + r.reason + '). It needs a standing network row (docs/DEPS.md "Egress"); the CEO has been asked in a handoff. Nothing was installed.');
  }
}
function askForRegistryRow() {
  if (fs.existsSync(F.justification)) return;
  const hosts = [].concat(...Object.values(REGISTRIES).map(r => r.hosts));
  const text = '# Package registries (company/tools/deps.js)\n\nThe crew installs packages only through company/tools/deps.js, which talks to these registries and no other host:\n\n' +
    hosts.map(h => '- `https://' + h + '/*`').join('\n') + '\n\nEach needs a standing external-gate row (category network, agent any). Every install is pinned to exact versions with registry hashes, ' +
    'runs no install scripts, and is licence-, age- and typo-checked before it lands (docs/DEPS.md).\n';
  fs.mkdirSync(path.dirname(F.justification), { recursive: true }); fs.writeFileSync(F.justification, text);
  const ceo = co.crew()[co.ceo()] || {};
  if (!ceo.inbox) return;
  const until = new Date(Date.now() + 365 * DAY).toISOString().slice(0, 10) + 'T00:00:00Z';
  const cmds = hosts.map(h => '`node company/tools/external-gate.js clear --by "' + (ceo.name || 'CEO') + '" --category network --target "https://' + h + '/*" --agent any --until ' + until + ' --justification ' + rel(F.justification) + ' --note "deps.js registry"`').join('\n');
  appendHandoff(ceo.inbox, '## ' + nowIso() + ' from deps.js — standing network rows for the package registries\n**Need:** record the three standing external-gate rows below (one per registry host) from your own run, so the crew can install packages through deps.js.\n' +
    '**Why:** deps.js asks the external gate before it reaches a registry; with no row it refuses every install.\n**Deadline:** today\n**Status:** OPEN\n**Evidence:** ' + rel(F.justification) + '\n' + cmds + '\n\n');
}
function appendHandoff(inbox, text) { const f = P('company', 'work', 'handoffs', inbox); fs.mkdirSync(path.dirname(f), { recursive: true }); require('./lib/tool-blocks').append(f, text); }   // recorded (lib/tool-blocks.js)
function fyiRisk(title, lines) {
  const r = riskSeat(); if (!r || !r.inbox) return;
  appendHandoff(r.inbox, '## ' + nowIso() + ' from deps.js — FYI: ' + title + '\n**Need:** nothing unless it was not meant.\n' + (lines || []).map(l => l + '\n').join('') + '**Deadline:** none\n**Status:** DONE — FYI\n**Evidence:** company/state/deps.json\n\n');
}

/* ---------------- governance ---------------- */
/* ASKS: what each governed act says to the owner (lib/governance.js decide): plain words up front, the ecosystem,
 * package, version and licence only in `technical`. Exported so a test files each at approve. */
const plainWhy = t => { const g = require('./lib/governance'); const x = t ? g.plainPart(String(t).replace(/\s+/g, ' ').trim().replace(/[.!]$/, '').slice(0, 200)) : null; return x ? x.replace(/^./, c => c.toLowerCase()) : null; };
const ASKS = {
  add: ({ eco, name, version, licence, why }) => ({ summary: 'add a free software library the crew needs',
    recommendation: plainWhy(why) ? 'yes: ' + plainWhy(why) : 'yes', default: 'it is not installed',
    technical: 'Add the ' + eco + ' package ' + name + ' ' + version + ' (licence ' + (licence || 'unknown') + ') for: ' + String(why || '').slice(0, 200) }),
  agpl: ({ eco, name, version, why }) => ({ summary: 'use a software library whose licence can oblige the company to publish its own code',
    recommendation: plainWhy(why) ? 'yes, if that is acceptable for the product: ' + plainWhy(why) : null, default: 'it is not installed',
    technical: 'Use the ' + eco + ' package ' + name + ' ' + version + ', which is AGPL-family licensed (network copyleft)' + (why ? '. Why: ' + String(why).slice(0, 200) : '') }),
};
// the crew's refusal when the owner was not asked (a summary that is not plain, a ruling, a "not now"): the real reason,
// never "question undefined"
const waitText = (gov, d) => d.questionId ? 'self-governance: deps is at approve, so this waits for the owner (question ' + d.questionId + ', an Approve button on Today).' : gov.refusal('deps', d);
function depsLevel() {
  const gov = require('./lib/governance');
  const d = gov.doc();
  // a company founded before the deps category existed: its file has no line for it, so the framework default applies
  if (d && d.categories && !Object.prototype.hasOwnProperty.call(d.categories, 'deps')) {
    const def = co.readJson(co.p('company', 'defaults', 'state', 'governance.json'), {}) || {};
    const v = def.categories && def.categories.deps;
    if (['auto', 'notify', 'approve'].includes(v)) return v;
  }
  return gov.level('deps', { triage: true });
}

/* ---------------- environments: generations behind a symlink ---------------- */
let GEN_N = 0;
const gen = () => Date.now().toString(36) + process.pid.toString(36) + (GEN_N++);
function current(link) { try { return fs.lstatSync(link).isSymbolicLink() ? path.join(path.dirname(link), fs.readlinkSync(link)) : null; } catch (_) { return null; } }
function swap(link, dir) {
  const t = link + '.swap-' + process.pid;
  try { fs.unlinkSync(t); } catch (_) {}
  if (!dir) { try { fs.unlinkSync(link); } catch (_) {} return; }
  fs.symlinkSync(path.basename(dir), t); fs.renameSync(t, link);   // rename over the old link: atomic
}
function prune(prefix, keep) {
  let names = []; try { names = fs.readdirSync(F.env); } catch (_) { return; }
  const k = new Set(keep.filter(Boolean).map(d => path.basename(d)));
  for (const n of names) if (n.startsWith(prefix + '-') && !k.has(n)) fs.rmSync(path.join(F.env, n), { recursive: true, force: true });
}
function withLock(fn) {
  fs.mkdirSync(F.env, { recursive: true });
  for (let i = 0; ; i++) {
    try { fs.writeFileSync(F.lock, String(process.pid), { flag: 'wx' }); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let stale = false; try { const pid = Number(fs.readFileSync(F.lock, 'utf8')); stale = !pid || (() => { try { process.kill(pid, 0); return false; } catch (_) { return true; } })() || Date.now() - fs.statSync(F.lock).mtimeMs > 3600000; } catch (_) { stale = true; }
      if (stale) { fs.rmSync(F.lock, { force: true }); continue; }
      if (i > 600) throw new Refusal('another deps.js change is running (company/env/.deps.lock)', 1);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
  try { return fn(); } finally { fs.rmSync(F.lock, { force: true }); }
}
function crashHook(stage) { if (process.env.DEPS_TEST_CRASH === stage) { process.stderr.write('deps.js: simulated crash at ' + stage + '\n'); process.exit(9); } }

/* ================= ecosystem: python ================= */
const pyNorm = n => String(n).toLowerCase().replace(/[-_.]+/g, '-');
const PY = {
  id: 'python', link: P('company', 'env', 'python'), prefix: 'python',
  validName: n => /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(n),
  norm: pyNorm,
  pipEnv: () => childEnv({ PIP_REQUIRE_VIRTUALENV: '1', PIP_CONFIG_FILE: os.devnull, PIP_NO_INPUT: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1', PYTHONNOUSERSITE: '1', PIP_USER: '0' }),
  py: dir => path.join(dir, 'bin', 'python'),
  binaryArgs(m) {
    const allowed = scriptsAllowed(m, 'python');
    return ['--only-binary', ':all:'].concat(allowed.length ? ['--no-binary', allowed.join(',')] : []);
  },
  newEnv() {
    const dir = path.join(F.env, 'python-' + gen());
    run(process.env.DEPS_PYTHON || 'python3', ['-m', 'venv', dir], { what: 'python3 -m venv' });
    return dir;
  },
  // metadata of one version from the registry JSON API: licence, files' sha256 digests, publish time, maintainers
  meta(reg, name, version) {
    const j = fetchJson(reg.json + '/' + encodeURIComponent(name) + '/' + (version ? encodeURIComponent(version) + '/' : '') + 'json', reg);
    if (!j || !j.info) return null;
    const files = j.urls || [];
    const times = files.map(u => Date.parse(u.upload_time_iso_8601 || u.upload_time)).filter(Number.isFinite);
    return { name: pyNorm(j.info.name || name), version: j.info.version, licence: pyLicenceText(j.info), homepage: j.info.home_page || (j.info.project_urls && (j.info.project_urls.Homepage || j.info.project_urls.Source)) || null,
      maintainers: [j.info.maintainer, j.info.author].filter(Boolean).map(String).map(s => s.slice(0, 80)), publishedAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
      yanked: files.length > 0 && files.every(u => u.yanked), hashes: files.map(u => u.digests && u.digests.sha256).filter(Boolean).map(h => 'sha256:' + h),
      hasWheel: files.some(u => u.packagetype === 'bdist_wheel'), scripts: !files.some(u => u.packagetype === 'bdist_wheel') };
  },
  // the whole tree for these direct pins, resolved by pip (no install), each dist with its registry metadata
  resolve(m, reg, pins, dir) {
    const report = path.join(F.tmp, 'pip-report-' + process.pid + '.json');
    fs.mkdirSync(F.tmp, { recursive: true });
    const r = run(PY.py(dir), ['-m', 'pip', 'install', '--dry-run', '--ignore-installed', '--quiet', '--no-cache-dir', '--report', report, '--index-url', reg.index].concat(PY.binaryArgs(m), pins.map(p => p.name + '==' + p.version)),
      { env: PY.pipEnv(), must: false, what: 'pip resolve' });
    if (r.status !== 0) {
      const err = String(r.stderr || '');
      const nb = /No matching distribution found for ([A-Za-z0-9._-]+)/.exec(err);
      if (nb) throw new Refusal('python ' + nb[1] + ': no wheel for this platform. Building from source runs the package\'s build scripts, so it needs the risk seat\'s approval: node company/tools/deps.js approve scripts python ' + nb[1] + ' --by <risk seat> --why "..."');
      throw new Refusal('pip could not resolve ' + pins.map(p => p.name + '==' + p.version).join(' ') + ': ' + err.trim().split('\n').slice(-4).join(' '), 1);
    }
    const rep = readJson(report, {}); fs.rmSync(report, { force: true });
    return (rep.install || []).map(it => {
      const md = it.metadata || {}; const name = pyNorm(md.name); const version = md.version;
      const h = ((it.download_info || {}).archive_info || {}).hashes || {};
      return { ecosystem: 'python', name, version, fetchedHash: h.sha256 ? 'sha256:' + h.sha256 : null, licenceMeta: pyLicenceText(md), requested: !!it.requested };
    });
  },
  lockText(dists) {
    return '# company/tools/deps.js python lock: pip install --require-hashes --no-deps --only-binary :all: -r <this>. Do not edit.\n' +
      dists.slice().sort((a, b) => a.name.localeCompare(b.name)).map(d => d.name + '==' + d.version + d.hashes.map(h => ' \\\n    --hash=' + h).join('')).join('\n') + '\n';
  },
  parseLock(text) {
    const out = []; const joined = String(text || '').replace(/\\\n/g, ' ');
    for (const l of joined.split('\n')) { const m = /^([A-Za-z0-9._-]+)==(\S+)(.*)$/.exec(l.trim()); if (m) out.push({ name: pyNorm(m[1]), version: m[2], hashes: [...m[3].matchAll(/--hash=(sha256:[0-9a-f]{64})/g)].map(x => x[1]) }); }
    return out;
  },
  install(m, reg, dir, lockText) {
    const lf = path.join(dir, 'requirements.lock'); fs.writeFileSync(lf, lockText);
    if (!PY.parseLock(lockText).length) return;
    run(PY.py(dir), ['-m', 'pip', 'install', '--require-hashes', '--no-deps', '--no-cache-dir', '--quiet', '--index-url', reg.index].concat(PY.binaryArgs(m), ['-r', lf]), { env: PY.pipEnv(), what: 'pip install (hash-checked)' });
  },
  installed(dir) {   // read-only: name -> version from the venv's dist-info folders
    const out = {};
    let sp = []; try { sp = fs.readdirSync(path.join(dir, 'lib')).filter(d => /^python/.test(d)).map(d => path.join(dir, 'lib', d, 'site-packages')); } catch (_) { return null; }
    for (const s of sp) { let ents = []; try { ents = fs.readdirSync(s); } catch (_) {} for (const e of ents) { const mm = /^(.+?)-([^-]+)\.dist-info$/.exec(e); if (mm) out[pyNorm(mm[1])] = mm[2]; } }
    for (const k of ['pip', 'setuptools']) delete out[k];
    return out;
  },
  usable(dir) { try { return fs.statSync(PY.py(dir)).isFile(); } catch (_) { return false; } },
  bins(dir) {
    let ents = []; try { ents = fs.readdirSync(path.join(dir, 'bin')); } catch (_) {}
    return ents.filter(n => !/^(python[\d.]*|pip[\d.]*|activate.*|Activate\.ps1|easy_install.*|wheel)$/.test(n)).map(n => ({ name: n, target: path.join('..', 'python', 'bin', n) }));
  },
  readStateLock: () => readText(F.pyLock),
  // an emptied lock stays as a file (a header, no lines): a deletion would read to locked-watch as a removed record
  writeStateLock(text) { if (text || fs.existsSync(F.pyLock)) writeTracked(F.pyLock, text || PY.lockText([])); },
};

/* ================= ecosystem: node ================= */
const NPM_ARGS = (reg, dir) => ['--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel=error', '--registry', reg.npm, '--cache', path.join(F.cache, 'npm'), '--userconfig', path.join(dir, '.npmrc')];
const NODE = {
  id: 'node', link: P('company', 'env', 'node'), prefix: 'node',
  validName: n => /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(n) && n.length <= 214,
  norm: n => String(n),
  packument(reg, name) { return fetchJson(reg.npm.replace(/\/?$/, '/') + name.replace('/', '%2f'), reg); },
  meta(reg, name, version, pk) {
    pk = pk || NODE.packument(reg, name); if (!pk || !pk.versions) return null;
    const v = version || (pk['dist-tags'] || {}).latest; const doc = pk.versions[v]; if (!doc) return null;
    const lic = doc.license || pk.license; const s = doc.scripts || {};
    return { name, version: v, licence: typeof lic === 'object' && lic ? String(lic.type || '') : String(lic || ''), homepage: doc.homepage || pk.homepage || null,
      maintainers: (pk.maintainers || doc.maintainers || []).map(x => String((x && x.name) || x).slice(0, 80)).slice(0, 6), publishedAt: (pk.time && pk.time[v]) || null,
      yanked: false, deprecated: doc.deprecated || null, integrity: doc.dist && doc.dist.integrity, hashes: doc.dist && doc.dist.integrity ? [doc.dist.integrity] : [],
      scripts: !!(s.preinstall || s.install || s.postinstall || doc.gypfile || doc.hasInstallScript) };
  },
  newEnv() { const dir = path.join(F.env, 'node-' + gen()); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, '.npmrc'), ''); return dir; },
  pkgJson: deps => JSON.stringify({ name: 'company-env', private: true, description: 'written by company/tools/deps.js', dependencies: deps }, null, 2) + '\n',
  resolve(m, reg, pins, dir) {
    const deps = {}; for (const p of pins) deps[p.name] = p.version;
    fs.writeFileSync(path.join(dir, 'package.json'), NODE.pkgJson(deps));
    const prev = readText(F.nodeLock); if (prev) fs.writeFileSync(path.join(dir, 'package-lock.json'), prev);   // keep locked versions where they still fit
    run('npm', ['install', '--package-lock-only', '--save-exact'].concat(NPM_ARGS(reg, dir)), { cwd: dir, env: childEnv(), what: 'npm resolve' });
    return NODE.parseLock(readText(path.join(dir, 'package-lock.json'))).map(d => Object.assign(d, { ecosystem: 'node', fetchedHash: d.hashes[0] || null }));
  },
  parseLock(text) {
    const j = (() => { try { return JSON.parse(text); } catch (_) { return null; } })(); if (!j || !j.packages) return [];
    return Object.entries(j.packages).filter(([k]) => k).map(([k, v]) => ({ name: v.name || k.slice(k.lastIndexOf('node_modules/') + 13), path: k, version: v.version, hashes: v.integrity ? [v.integrity] : [], licenceMeta: v.license || '', lockScripts: !!v.hasInstallScript }));
  },
  lockText: (dists, dir) => readText(path.join(dir, 'package-lock.json')),
  install(m, reg, dir, lockText, pkgText) {
    if (pkgText) fs.writeFileSync(path.join(dir, 'package.json'), pkgText);
    fs.writeFileSync(path.join(dir, 'package-lock.json'), lockText);
    run('npm', ['ci'].concat(NPM_ARGS(reg, dir)), { cwd: dir, env: childEnv(), what: 'npm ci (integrity-checked)' });
    for (const n of scriptsAllowed(m, 'node')) if (fs.existsSync(path.join(dir, 'node_modules', n))) run('npm', ['rebuild', n, '--ignore-scripts=false'].concat(NPM_ARGS(reg, dir).filter(a => a !== '--ignore-scripts')), { cwd: dir, env: childEnv(), what: 'npm rebuild ' + n + ' (risk-approved scripts)' });
  },
  installed(dir) {
    const lock = NODE.parseLock(readText(path.join(dir, 'package-lock.json'))); if (!fs.existsSync(path.join(dir, 'node_modules'))) return null;
    const out = {}; for (const d of lock) { const pj = readJson(path.join(dir, d.path, 'package.json'), null); if (pj) out[d.path] = pj.version; }
    return out;
  },
  usable: dir => fs.existsSync(path.join(dir, 'node_modules')),
  bins(dir) { let ents = []; try { ents = fs.readdirSync(path.join(dir, 'node_modules', '.bin')); } catch (_) {} return ents.map(n => ({ name: n, target: path.join('..', 'node', 'node_modules', '.bin', n) })); },
  readStateLock: () => readText(F.nodeLock),
  writeStateLock(text, pkgText) {
    if (!text && !fs.existsSync(F.nodeLock)) return;
    writeTracked(F.nodePkg, text ? pkgText : NODE.pkgJson({})); writeTracked(F.nodeLock, text || JSON.stringify({ name: 'company-env', lockfileVersion: 3, requires: true, packages: {} }, null, 2) + '\n');
  },
};

// the plug-in table: a later container-only `system` ecosystem goes here with the same interface
const ECOSYSTEMS = { python: PY, node: NODE };
const SYSTEM_WORDS = ['system', 'apt', 'apt-get', 'dnf', 'yum', 'pacman', 'apk', 'zypper', 'brew', 'snap', 'port'];

function scriptsAllowed(m, eco) { return [...new Set((m.approvals || []).filter(a => a.kind === 'scripts' && a.ecosystem === eco).map(a => a.name))]; }
function securityFix(eco, name, version) {
  try { return require('./security-watch.js').fastTrack(eco === 'python' ? 'PyPI' : 'npm', name, version, { root: ROOT }); } catch (_) { return null; }
}
function approvalFor(m, kind, eco, name, version) {
  return (m.approvals || []).find(a => a.kind === kind && a.ecosystem === eco && a.name === name && (!a.version || !version || a.version === version)) || null;
}
const directPins = (m, eco) => Object.values(m.packages).filter(p => p.ecosystem === eco && p.direct).map(p => ({ name: p.name, version: p.version }));

/* ---------------- checks over the resolved tree ---------------- */
function checkTree(m, E, reg, dists, direct) {
  const problems = []; const metas = {};
  const old = d => { const p = m.packages[key(E.id, d.name)]; return p && p.version === d.version ? p : null; };
  for (const d of dists) {
    const prev = old(d);
    const meta = prev ? { licence: prev.licence, homepage: prev.homepage, maintainers: prev.maintainers, publishedAt: prev.publishedAt, hashes: prev.hashes, scripts: prev.scripts } : E.meta(reg, d.name, d.version);
    if (!meta) { problems.push({ kind: 'registry-missing', d, why: E.id + ' ' + d.name + '==' + d.version + ' is not on the registry\'s metadata API', hard: true }); continue; }
    metas[d.name] = meta;
    // G1: the hash that will be enforced is the registry's; what pip/npm fetched must be one of them
    if (!meta.hashes || !meta.hashes.length) problems.push({ kind: 'integrity', d, why: E.id + ' ' + d.name + '==' + d.version + ': the registry publishes no hash, so its bytes cannot be checked', hard: true });
    else if (d.fetchedHash && !meta.hashes.includes(d.fetchedHash)) problems.push({ kind: 'integrity', d, why: E.id + ' ' + d.name + '==' + d.version + ': the resolver\'s hash is not one the registry publishes', hard: true });
    if (prev) continue;
    if (meta.yanked) problems.push({ kind: 'yanked', d, why: E.id + ' ' + d.name + '==' + d.version + ' was yanked by its maintainers; pick another version', hard: true });
    const lic = classifyLicence(meta.licence || d.licenceMeta);
    meta.licenceClass = lic.cls;
    if (lic.cls === 'owner') problems.push({ kind: 'agpl', d, why: E.id + ' ' + d.name + '==' + d.version + ' is licensed ' + lic.id + ' (network copyleft): that is a commercial decision for a server product, so it needs the owner' });
    else if (lic.cls === 'risk') problems.push({ kind: 'licence', d, why: E.id + ' ' + d.name + '==' + d.version + ' has licence "' + (lic.id || 'unknown') + '": needs the risk seat\'s approval' });
    const age = meta.publishedAt ? (Date.now() - Date.parse(meta.publishedAt)) / DAY : null;
    const min = Number((m.policy || {}).minAgeDays); const minDays = Number.isFinite(min) ? min : 7;
    if (age === null || age < minDays) problems.push({ kind: 'age', d, why: E.id + ' ' + d.name + '==' + d.version + (age === null ? ' has no publish date on the registry' : ' was published ' + age.toFixed(1) + ' days ago (under ' + minDays + ')') + ': needs the risk seat\'s approval' });
    if (meta.scripts || d.lockScripts) problems.push({ kind: 'scripts', d, why: E.id + ' ' + d.name + '==' + d.version + ' runs install or build scripts: refused unless the risk seat puts it on the scripts allow-list' });
    if (direct.has(d.name)) { const t = typoOf(E.id, d.name); if (t) problems.push({ kind: 'typo', d, why: E.id + ' ' + d.name + ' is one slip from the popular "' + t + '" (a typosquat?): needs the risk seat\'s approval' }); }
  }
  return { problems, metas };
}

/* ---------------- one transaction: resolve, check, govern, install, swap, record ---------------- */
function apply(E, m, reg, pins, ctx) {
  const dir = E.newEnv();
  let swapped = false;
  try {
    const dists = pins.length ? E.resolve(m, reg, pins, dir) : [];
    const direct = new Set(pins.map(p => p.name));
    const { problems, metas } = checkTree(m, E, reg, dists, direct);
    const open = [];
    for (const p of problems) {
      if (p.hard) { open.push(p); continue; }
      if (p.kind === 'agpl') {
        const gov = require('./lib/governance');
        const ref = 'deps:agpl:' + E.id + ':' + p.d.name + '==' + p.d.version;
        const d = gov.decide('deps', Object.assign({ by: ctx.seat.name, ref }, ASKS.agpl({ eco: E.id, name: p.d.name, version: p.d.version, why: ctx.why })), { level: 'approve' });
        if (!d.allowed) open.push(Object.assign({}, p, { why: p.why + (d.questionId ? ' (owner question ' + d.questionId + (d.denied ? ': the owner said no' : '') + ')' : ' (' + gov.refusal('deps', d) + ')') }));
        continue;
      }
      if (p.kind === 'scripts' && scriptsAllowed(m, E.id).includes(p.d.name)) continue;
      // security fast track (docs/SECURITY-WATCH.md): the exact first fixed release of an open P0 here skips the age wait
      // (and only that: licence, scripts, typo, integrity and governance still apply); recorded in the deps log
      if (p.kind === 'age') { const ft = securityFix(E.id, p.d.name, p.d.version); if (ft) { logRow({ act: 'age-waived', ecosystem: E.id, name: p.d.name, version: p.d.version, by: ctx.seat.name, security: ft.advisory, finding: ft.id }); continue; } }
      if (!approvalFor(m, p.kind, E.id, p.d.name, ['licence', 'age'].includes(p.kind) ? p.d.version : null)) open.push(p);
    }
    if (open.length) {
      logRow({ act: 'refused', ecosystem: E.id, by: ctx.seat.name, pins, problems: open.map(p => p.kind + ':' + p.d.name + '==' + p.d.version) });
      throw new Refusal('refused, nothing installed:\n' + open.map(p => '  - ' + p.why + (['licence', 'age', 'scripts', 'typo'].includes(p.kind) ? '\n      approve: node company/tools/deps.js approve ' + p.kind + ' ' + E.id + ' ' + p.d.name + (['licence', 'age'].includes(p.kind) ? '==' + p.d.version : '') + ' --by <risk seat> --why "..."' : '')).join('\n'));
    }
    if (ctx.govern) { const g = ctx.govern(); if (g) return g; }
    // the lock carries the REGISTRY's hashes (every file of the version), so the install is checked against them
    const full = dists.map(d => Object.assign({}, d, { hashes: E.id === 'python' ? metas[d.name].hashes : d.hashes }));
    const lockText = E.id === 'python' ? E.lockText(full) : E.lockText(full, dir);
    const pkgText = E.id === 'node' ? readText(path.join(dir, 'package.json')) : null;
    E.install(m, reg, dir, lockText, pkgText);
    verifyEnv(E, dir, lockText);
    crashHook('before-swap');
    const prev = current(E.link);
    swap(E.link, pins.length ? dir : null); swapped = true;
    E.writeStateLock(pins.length ? lockText : null, pkgText);
    // the manifest: this ecosystem's rows are exactly the resolved tree
    for (const k of Object.keys(m.packages)) if (m.packages[k].ecosystem === E.id) { const d = full.find(x => key(E.id, x.name) === k); if (!d) delete m.packages[k]; }
    for (const d of full) {
      const k = key(E.id, d.name); const was = m.packages[k] || {}; const meta = metas[d.name] || {};
      const isDirect = direct.has(d.name);
      m.packages[k] = { ecosystem: E.id, name: d.name, version: d.version, direct: isDirect, hashes: d.hashes, licence: meta.licence || d.licenceMeta || 'unknown', licenceClass: meta.licenceClass || was.licenceClass || classifyLicence(meta.licence || d.licenceMeta).cls,
        homepage: meta.homepage || null, maintainers: meta.maintainers || [], publishedAt: meta.publishedAt || null, scripts: !!(meta.scripts || d.lockScripts), registry: reg.id,
        addedBy: isDirect && ctx.name === d.name ? ctx.seat.name : (was.version === d.version && was.addedBy) || (isDirect ? was.addedBy || ctx.seat.name : 'via ' + [...direct].join(', ')),
        why: isDirect && ctx.name === d.name ? ctx.why : (was.why || (isDirect ? ctx.why : 'required by ' + [...direct].join(', '))),
        at: was.version === d.version && was.at ? was.at : nowIso() };
    }
    m.env[E.id] = pins.length ? { current: path.basename(dir), previous: prev ? path.basename(prev) : null, builtAt: nowIso(), root: ROOT } : { current: null, previous: prev ? path.basename(prev) : null, builtAt: nowIso(), root: ROOT };
    stampLocks(m); save(m);
    relinkBins();
    prune(E.prefix, [dir, prev]);
    return { ok: true, dists: full };
  } finally {
    if (!swapped) fs.rmSync(dir, { recursive: true, force: true });
  }
}
function stampLocks(m) { m.locks = {}; for (const f of [F.pyLock, F.nodePkg, F.nodeLock]) { const b = readText(f); if (b !== null) m.locks[rel(f)] = sha256(Buffer.from(b)); } }
// the installed set must be exactly the lock's
function verifyEnv(E, dir, lockText) {
  const want = E.parseLock(lockText); const have = E.installed(dir) || {};
  const miss = want.filter(d => have[E.id === 'node' ? d.path : d.name] !== d.version);
  if (miss.length) throw new Refusal('the new ' + E.id + ' environment does not match its lock (' + miss.slice(0, 4).map(d => d.name + '==' + d.version).join(', ') + '); the current environment is untouched', 1);
  if (E.id === 'python') { const extra = Object.keys(have).filter(n => !want.some(d => d.name === n)); if (extra.length) throw new Refusal('the new python environment holds packages the lock does not (' + extra.join(', ') + ')', 1); }
}
function relinkBins() {
  const dir = path.join(F.env, 'bin-' + gen()); fs.mkdirSync(dir, { recursive: true });
  const seen = new Set();
  for (const E of Object.values(ECOSYSTEMS)) { const c = current(E.link); if (!c || !fs.existsSync(c)) continue; for (const b of E.bins(c)) { if (seen.has(b.name)) continue; seen.add(b.name); fs.symlinkSync(b.target, path.join(dir, b.name)); } }
  const prev = current(F.bin); swap(F.bin, dir); prune('bin', [dir]);
  return [...seen];
}

/* ---------------- commands ---------------- */
function parseSpec(E, spec) {
  const m = /^([^=<>!~\s]+)(?:==([A-Za-z0-9.+!_-]+))?$/.exec(String(spec || '').trim());
  if (!m) throw new Usage('package must be <name> or <name>==<exact version> (no ranges): "' + spec + '"');
  if (!E.validName(m[1])) throw new Usage('"' + m[1] + '" is not a valid ' + E.id + ' package name');
  return { name: E.norm(m[1]), version: m[2] || null };
}
function refuseTampered() {
  const t = tampered();
  if (!t.length) return;
  const m = readJson(F.manifest, {}) || {};
  const digest = sha256(Buffer.from(t.join('|') + t.map(f => readText(P(f.replace(/ \(deleted\)$/, ''))) || '').join('|'))).slice(7, 23);
  if (!fs.existsSync(path.join(F.tmp, 'tamper-' + digest))) {
    fs.mkdirSync(F.tmp, { recursive: true }); fs.writeFileSync(path.join(F.tmp, 'tamper-' + digest), nowIso());
    fyiRisk('a dependency lock or manifest was edited outside deps.js', ['**Files:** ' + t.join(', '), '**What it means:** deps.js refuses to install or rebuild from it until it is put back (locked-watch.js revert <path>, or the last backup).']);
    logRow({ act: 'tampered', files: t, manifestVersion: m.version || null });
  }
  throw new Refusal('refused: ' + t.join(', ') + ' was changed outside deps.js (its bytes are not the tool\'s last recorded write). Nothing is installed or rebuilt from it; the risk seat has been told. Put it back with node company/tools/locked-watch.js revert <path> --by <name>.');
}
function refuseSystem(spec, seat, why) {
  const pkg = String(spec || '').trim().slice(0, 60) || 'a system package';
  const about = 'deps:system:' + pkg;
  const asked = (readText(F.inbox) || '').split('\n').some(l => l.includes('"about":"' + about + '"'));
  if (!asked && seat) {
    const msg = 'The crew would like the system program "' + pkg + '" on this machine' + (why ? ' (' + String(why).slice(0, 160).replace(/\.$/, '') + ')' : '') + '. ' +
      'Installing system programs needs administrator rights on the host, which the crew does not have on purpose, so it cannot do this itself. ' +
      'If you want it, have it installed on the machine (or in the company\'s container image); if not, say no and the crew will do without it.';
    const r = run(process.execPath, [path.join(__dirname, 'inbox.js'), 'ask', '--from', seat.name, '--message', msg, '--details', 'Asked through company/tools/deps.js, which installs only Python and Node packages inside the company folder.', '--about', about, '--via', 'deps.js'], { env: process.env, must: false, cwd: ROOT });
    if (r.status !== 0) process.stderr.write('deps.js: could not file the owner question: ' + String(r.stderr || '').trim().slice(0, 200) + '\n');
  }
  throw new Refusal('needs the owner: system packages install on the host. deps.js installs only python and node packages inside the company folder' + (asked ? '; the owner question for "' + pkg + '" is already open.' : '; an owner question explains what is needed.'));
}

function add(eco, spec, o) {
  if (SYSTEM_WORDS.includes(String(eco || '').toLowerCase())) return refuseSystem(spec, seatOf(o.by), o.why);
  const E = ECOSYSTEMS[eco]; if (!E) throw new Usage('ecosystem must be one of ' + Object.keys(ECOSYSTEMS).join(', ') + ' (system packages: refused)');
  if (!o.why || !String(o.why).trim()) throw new Usage('--why "..." is required: say what the package is for');
  const seat = needSeat(o.by);
  return withLock(() => {
    refuseTampered();
    const m = load(); const reg = registry(eco);
    const want = parseSpec(E, spec);
    if (!REGISTRIES[eco] || reg.id !== REGISTRIES[eco].id) { if (!approvalFor(m, 'registry', eco, reg.id)) throw new Refusal('refused: the registry "' + reg.id + '" is not one of the company\'s (' + REGISTRIES[eco].hosts.join(', ') + '); a new registry needs the risk seat\'s approval: node company/tools/deps.js approve registry ' + eco + ' ' + reg.id + ' --by <risk seat> --why "..."'); }
    gateNet(reg, seat);
    const meta = E.meta(reg, want.name, want.version);
    if (!meta) throw new Refusal(eco + ' ' + want.name + (want.version ? '==' + want.version : '') + ' was not found on the registry', 1);
    const version = meta.version;   // "latest" is resolved to an exact version here, once
    const name = E.id === 'python' ? pyNorm(meta.name || want.name) : want.name;
    const k = key(eco, name);
    if (m.packages[k] && m.packages[k].direct && m.packages[k].version === version && current(E.link)) { console.log(eco + ' ' + name + '==' + version + ' is already installed (nothing to do)'); return { ok: true, unchanged: true }; }
    const pins = directPins(m, eco).filter(p => p.name !== name).concat([{ name, version }]);
    const lv = depsLevel();
    const ref = 'deps:add:' + eco + ':' + name + '==' + version;
    const govern = () => {
      if (lv !== 'approve' && lv !== 'triage') return null;
      const gov = require('./lib/governance');
      const d = gov.decide('deps', Object.assign({ by: seat.name, ref }, ASKS.add({ eco, name, version, licence: meta.licence, why: o.why })));
      if (d.allowed) return null;
      if (d.denied) { delete m.pending[ref]; save(m); throw new Refusal(gov.refusal('deps', d)); }
      if (!d.questionId) throw new Refusal(waitText(gov, d));
      m.pending[ref] = { ecosystem: eco, name, version, by: seat.name, byId: seat.id, why: String(o.why), questionId: d.questionId, at: (m.pending[ref] && m.pending[ref].at) || nowIso() };
      save(m);
      logRow({ act: 'waiting', ecosystem: eco, name, version, by: seat.name, questionId: d.questionId });
      throw new Refusal(waitText(gov, d) + ' Once approved, the next deps.js verify installs it; the deps duty wakes ' + seat.name + '.');
    };
    const r = apply(E, m, reg, pins, { seat, why: String(o.why), name, govern });
    if (r && r.ok) {
      delete m.pending[ref]; save(m);
      const row = m.packages[k];
      logRow({ act: 'added', ecosystem: eco, name, version, by: seat.name, why: String(o.why), licence: row.licence, level: lv, tree: r.dists.length });
      if (lv === 'notify') fyiRisk(seat.name + ' added ' + eco + ' ' + name + '==' + version + ' (' + row.licence + ')', ['**Why:** ' + String(o.why).slice(0, 200), '**Tree:** ' + r.dists.length + ' package(s), all pinned with registry hashes; self-governance deps is notify.']);
      console.log('added ' + eco + ' ' + name + '==' + version + ' (' + row.licence + '; ' + r.dists.length + ' package(s) in the tree, hash-pinned). CLIs: company/env/bin (node company/tools/deps.js run <bin>)');
    }
    return r;
  });
}
function remove(spec, o) {
  const seat = needSeat(o.by);
  return withLock(() => {
    refuseTampered();
    const m = load();
    const hits = Object.values(m.packages).filter(p => p.direct && (p.name === spec || p.name === pyNorm(spec)) && (!o.ecosystem || p.ecosystem === o.ecosystem));
    if (!hits.length) throw new Refusal(spec + ' is not a direct dependency (node company/tools/deps.js list)', 1);
    if (hits.length > 1) throw new Usage(spec + ' is in more than one ecosystem: add --ecosystem python|node');
    const p = hits[0]; const E = ECOSYSTEMS[p.ecosystem]; const reg = registry(p.ecosystem);
    const pins = directPins(m, p.ecosystem).filter(x => x.name !== p.name);
    if (pins.length) gateNet(reg, seat);
    apply(E, m, reg, pins, { seat, why: null, name: null });
    logRow({ act: 'removed', ecosystem: p.ecosystem, name: p.name, version: p.version, by: seat.name });
    console.log('removed ' + p.ecosystem + ' ' + p.name + '==' + p.version);
    return { ok: true };
  });
}
function approve(kind, eco, target, o) {
  const KINDS = ['licence', 'age', 'scripts', 'typo', 'registry'];
  if (!KINDS.includes(kind)) throw new Usage('approve <' + KINDS.join('|') + '> <ecosystem> <package>[==version]|<registry id>');
  if (!ECOSYSTEMS[eco]) throw new Usage('ecosystem must be one of ' + Object.keys(ECOSYSTEMS).join(', '));
  if (!o.why) throw new Usage('--why "..." is required');
  const seat = needSeat(o.by); const risk = riskSeat();
  if (!seat.owner && !(risk && risk.id === seat.id)) throw new Refusal('only the risk seat (' + (risk ? risk.name : 'none') + ') or the owner approves a dependency exception');
  return withLock(() => {
    refuseTampered();
    const m = load();
    const sp = kind === 'registry' ? { name: String(target), version: null } : parseSpec(ECOSYSTEMS[eco], target);
    if (['licence', 'age'].includes(kind) && !sp.version) throw new Usage('a ' + kind + ' approval names an exact version: <package>==<version>');
    m.approvals.push({ kind, ecosystem: eco, name: sp.name, version: sp.version, by: seat.name, why: String(o.why), at: nowIso() });
    save(m); logRow({ act: 'approved', kind, ecosystem: eco, name: sp.name, version: sp.version, by: seat.name });
    console.log('approved ' + kind + ' for ' + eco + ' ' + sp.name + (sp.version ? '==' + sp.version : '') + ' (by ' + seat.name + ')');
    return { ok: true };
  });
}

/* ---------------- verify / rebuild / duty ---------------- */
function envState(E, m) {
  const lockText = E.readStateLock(); const want = lockText ? E.parseLock(lockText) : [];
  const dir = current(E.link);
  if (!want.length) return { ok: true, empty: true };
  const recordedRoot = m.env && m.env[E.id] && m.env[E.id].root;
  if (recordedRoot && path.resolve(recordedRoot) !== ROOT) return { ok: false, why: 'the company folder moved (built at ' + recordedRoot + ')' };
  if (!dir || !fs.existsSync(dir) || !E.usable(dir)) return { ok: false, why: 'missing' };
  if (E.id === 'node' && readText(path.join(dir, 'package-lock.json')) !== lockText) return { ok: false, why: 'its lock differs from company/state/deps' };
  const have = E.installed(dir) || {};
  const off = want.filter(d => have[E.id === 'node' ? d.path : d.name] !== d.version);
  if (off.length) return { ok: false, why: off.length + ' package(s) differ from the lock' };
  return { ok: true };
}
function rebuild(E, m) {
  const lockText = E.readStateLock();
  const prev = m.env && m.env[E.id] && m.env[E.id].previous && path.join(F.env, m.env[E.id].previous);
  // the kept previous generation, if it matches the lock exactly, is a rollback with no network
  if (prev && fs.existsSync(prev) && (m.env[E.id].root ? path.resolve(m.env[E.id].root) === ROOT : true)) {
    const have = E.installed(prev) || {}; const want = E.parseLock(lockText);
    if (E.usable(prev) && want.every(d => have[E.id === 'node' ? d.path : d.name] === d.version) && (E.id !== 'node' || readText(path.join(prev, 'package-lock.json')) === lockText)) {
      const cur = current(E.link); swap(E.link, prev); m.env[E.id] = Object.assign({}, m.env[E.id], { current: path.basename(prev), previous: cur ? path.basename(cur) : null, builtAt: nowIso() });
      return 'rolled back to ' + path.basename(prev);
    }
  }
  const reg = registry(E.id);
  if (reg.local && !approvalFor(m, 'registry', E.id, reg.id)) throw new Refusal('the registry "' + reg.id + '" is not approved');
  gateNet(reg, seatOf('owner') || { id: 'owner', owner: true });
  const dir = E.newEnv(); let ok = false;
  try {
    E.install(m, reg, dir, lockText, E.id === 'node' ? readText(F.nodePkg) : null);
    verifyEnv(E, dir, lockText);
    const cur = current(E.link); swap(E.link, dir); ok = true;
    m.env[E.id] = { current: path.basename(dir), previous: cur && fs.existsSync(cur) ? path.basename(cur) : null, builtAt: nowIso(), root: ROOT };
    prune(E.prefix, [dir, m.env[E.id].previous && path.join(F.env, m.env[E.id].previous)]);
    return 'rebuilt from the lock (hash-checked)';
  } finally { if (!ok) fs.rmSync(dir, { recursive: true, force: true }); }
}
function verify(o) {
  o = o || {};
  const lines = []; let bad = 0;
  withLock(() => {
    refuseTampered();
    const m = load(); let changed = false;
    for (const f of Object.keys(m.locks || {})) { const b = readText(P(f)); if (b === null || sha256(Buffer.from(b)) !== m.locks[f]) { refuseTampered(); throw new Refusal('refused: ' + f + ' does not match the digest the manifest recorded'); } }
    for (const E of Object.values(ECOSYSTEMS)) {
      const s = envState(E, m);
      if (s.ok) { lines.push(E.id + ': ' + (s.empty ? 'no packages' : 'ok, matches the lock')); continue; }
      lines.push(E.id + ': ' + s.why + ' — ' + rebuild(E, m)); changed = true;
    }
    const want = new Set([].concat(...Object.values(ECOSYSTEMS).map(E => { const c = current(E.link); return c ? E.bins(c).map(b => b.name) : []; })));
    const have = (() => { try { return new Set(fs.readdirSync(F.bin)); } catch (_) { return null; } })();
    if (changed || !have || [...want].some(n => !have.has(n)) || [...have].some(n => !want.has(n))) { if (want.size || have) { relinkBins(); lines.push('bin: links rebuilt (' + want.size + ')'); } }
    if (changed) { stampLocks(m); save(m); }
  });
  // owner questions answered since: an approved add is installed now, a declined one is dropped
  const m2 = load(); const gov = require('./lib/governance');
  for (const [ref, p] of Object.entries(m2.pending || {})) {
    const a = gov.approved(ref);
    if (a === true) { try { add(p.ecosystem, p.name + '==' + p.version, { by: p.by, why: p.why }); lines.push('pending ' + p.name + ': approved by the owner, installed'); } catch (e) { bad++; lines.push('pending ' + p.name + ': ' + e.message); } }
    else if (a === false) { withLock(() => { const m3 = load(); delete m3.pending[ref]; save(m3); }); lines.push('pending ' + p.name + ': the owner said no; dropped'); }
    else lines.push('pending ' + p.name + ': waiting for the owner (' + p.questionId + ')');
  }
  const adhoc = adhocInstalls(Date.now() - DAY);
  if (adhoc.length) lines.push('ad hoc installs outside deps.js in the last 24 h: ' + adhoc.length + ' (' + [...new Set(adhoc.map(a => a.name))].join(', ') + ') — the deps duty reports them to the risk seat');
  for (const l of lines) console.log(l);
  return bad ? 1 : 0;
}
function duty() {
  const items = []; const reasons = [];
  const t = tampered();
  if (t.length) { items.push({ id: 'deps:tampered', route: 'risk' }); reasons.push(t.length + ' dependency file(s) edited outside deps.js'); }
  const m = load();
  if (!t.length) for (const E of Object.values(ECOSYSTEMS)) { const s = envState(E, m); if (!s.ok) { items.push({ id: 'deps:env:' + E.id, route: 'tools' }); reasons.push(E.id + ' environment ' + (s.why === 'missing' ? 'missing' : 'differs from its lock')); } }
  let gov = null; try { gov = require('./lib/governance'); } catch (_) {}
  for (const [ref, p] of Object.entries(m.pending || {})) { if (gov && gov.approved(ref) !== null) { items.push({ id: 'deps:pending:' + p.questionId, route: p.byId || 'tools' }); reasons.push('owner answered ' + p.questionId); } }
  const adhoc = openAdhoc(adhocInstalls(Date.now() - DAY), m);
  for (const a of adhoc.slice(0, 20)) items.push({ id: 'deps:adhoc:' + a.runId, route: 'risk' });
  if (adhoc.length) reasons.push(adhoc.length + ' ad hoc install(s) outside deps.js in 24 h (' + [...new Set(adhoc.map(a => a.pkg || '?'))].join(', ') + ')');
  if (!items.length) return 0;
  const reason = dutyReason(reasons, { tampered: t.length > 0, env: items.some(i => /^deps:env:/.test(i.id)), adhoc: adhoc.length > 0 });
  process.stdout.write(JSON.stringify({ due: true, reason, route: items[0].route, key: sha256(Buffer.from(items.map(i => i.id).join(','))).slice(7, 23), items }) + '\n');
  return 1;
}

// what to do, per finding; none of it is the owner's (the risk seat and the tools seat handle it, never an owner question)
function dutyReason(reasons, k) {
  const fix = [];
  if (k.tampered) fix.push('tampered lock: the risk seat reviews it (locked-watch.js revert or accept)');
  if (k.env) fix.push('environment: node company/tools/deps.js verify --rebuild');
  if (k.adhoc) fix.push('ad hoc install: the risk seat keeps it with `deps.js adopt <python|node> <package>==<version> --by <seat> --why ..` (installs that version through deps.js checks; then remove the ad hoc copy) or, once it is removed or not needed, `deps.js settle <package> --by <risk seat> --why ..`');
  return (reasons.join('; ') + '. Fix: ' + fix.join('; ') + '. Not an owner question.').slice(0, 600);
}
// ad hoc installs not yet settled (adopt or settle records the package and when; an install after that is new)
function openAdhoc(list, m) { const st = (m && m.adhocSettled) || {}; return list.filter(a => !(a.pkg && st[a.pkg] && Date.parse(st[a.pkg].at) >= a.ts)); }
function settle(pkg, o, how) {
  const name = String(pkg || '').trim().toLowerCase().replace(/(==|@(?=\d)).*$/, ''); if (!name) throw new Usage('settle <package> --by <risk seat> --why "..."');
  if (!o.why || !String(o.why).trim()) throw new Usage('--why "..." is required');
  const seat = needSeat(o.by); const risk = riskSeat();
  if (!how && !seat.owner && !(risk && risk.id === seat.id)) throw new Refusal('only the risk seat (' + (risk ? risk.name : 'none') + ') or the owner settles an ad hoc install');
  return withLock(() => {
    refuseTampered();
    const m = load(); m.adhocSettled = m.adhocSettled || {};
    m.adhocSettled[name] = { at: nowIso(), by: seat.name, how: how || 'settled', why: String(o.why) };
    save(m); return { ok: true, package: name, how: how || 'settled' };
  });
}

/* ---------------- ad hoc installs in the agents' transcripts ---------------- */
// a package install that did not go through deps.js: a named pip install (not -r / -e / .), any --user or
// --break-system-packages install, pipx / uv tool, a global npm/yarn/pnpm install, or a system package manager
const ADHOC_INSTALL = new RegExp([
  String.raw`(?:^|[\s;&|(\x60'"/])(?:python3?(?:\.\d+)?\s+-m\s+)?pip3?(?:\.\d+)?\s+install\s+(?:-(?!r\b|e\b|-requirement|-editable|-constraint|c\b)\S*\s+)*(?![-.])[A-Za-z0-9]`,
  String.raw`\bpip3?(?:\.\d+)?\s+install\b[^;&|\n]*\s--(?:user|break-system-packages)\b`,
  String.raw`(?:^|[\s;&|(\x60'"/])(?:pipx|uv\s+tool)\s+install\b`,
  String.raw`(?:^|[\s;&|(\x60'"/])(?:npm|pnpm)\s+(?:install|i|add)\b[^;&|\n]*\s(?:-g|--global)\b`,
  String.raw`(?:^|[\s;&|(\x60'"/])yarn\s+global\s+add\b`,
  String.raw`(?:^|[\s;&|(\x60'"/])(?:apt|apt-get|dnf|yum|apk|zypper|brew|snap)\s+(?:-\S+\s+)*install\b|(?:^|[\s;&|(\x60'"/])pacman\s+-S`,
].join('|'));
// the first package named after "install"/"add" (flags and their values skipped), lower-case and without a version: for settling
function adhocPackage(cmd) {
  const m = String(cmd || '').match(/(?:\binstall|\badd|\bi|-S)\s+((?:-\S+\s+)*)([A-Za-z0-9@][A-Za-z0-9@._/-]*)/);
  return m ? m[2].replace(/(==|@(?=\d)|>=|<=|~=).*$/, '').toLowerCase() : null;
}
const isAdhoc = cmd => ADHOC_INSTALL.test(String(cmd || '')) && !/company\/tools\/deps\.js|\bdeps\.js\b/.test(String(cmd || ''));
function adhocInstalls(sinceMs) {
  const dir = P('.starnet-data', 'workspaces', 'transcript-history-v2');
  let files = []; try { files = fs.readdirSync(dir).filter(f => /^segment-\d+\.jsonl$/.test(f)).sort().slice(-6); } catch (_) { return []; }
  const out = [];
  for (const f of files) {
    const fp = path.join(dir, f); try { if (fs.statSync(fp).mtimeMs < sinceMs) continue; } catch (_) { continue; }
    let txt = ''; try { txt = fs.readFileSync(fp, 'utf8'); } catch (_) { continue; }
    for (const l of txt.split('\n')) {
      if (!l.includes('toolCalls') || !l.includes('install')) continue;
      let r; try { r = JSON.parse(l); } catch (_) { continue; }
      if (!r || !(Number(r.ts) >= sinceMs) || !r.agentId) continue;
      let calls; try { calls = typeof r.toolCalls === 'string' ? JSON.parse(r.toolCalls) : r.toolCalls; } catch (_) { continue; }
      for (const tc of Array.isArray(calls) ? calls : []) {
        const fn = (tc && tc.function) || {}; if (!/shell|exec|bash|terminal|run_command/i.test(String(fn.name || ''))) continue;
        let a = fn.arguments; if (typeof a === 'string') { try { a = JSON.parse(a); } catch (_) { a = { command: a }; } }
        const cmd = String((a && (a.command || a.cmd || a.script)) || '');
        if (isAdhoc(cmd)) out.push({ agentId: String(r.agentId), name: co.nameOf(String(r.agentId)), runId: String(r.sourceRunId || r.runId || 'run').slice(0, 12), ts: Number(r.ts), pkg: adhocPackage(cmd) });
      }
    }
  }
  return out;
}

/* ---------------- list / run ---------------- */
function list(json) {
  const m = load();
  if (json) { console.log(JSON.stringify({ packages: m.packages, approvals: m.approvals, pending: m.pending, env: m.env, policy: m.policy }, null, 1)); return 0; }
  const rows = Object.values(m.packages).sort((a, b) => (b.direct - a.direct) || a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name));
  if (!rows.length) console.log('no dependencies (add one: node company/tools/deps.js add <python|node> <package> --why "..." --by <seat>)');
  for (const p of rows) console.log((p.direct ? '' : '  ') + p.ecosystem.padEnd(7) + ' ' + (p.name + '==' + p.version).padEnd(34) + ' ' + String(p.licence).slice(0, 18).padEnd(18) + ' ' + (p.direct ? p.addedBy + ': ' + String(p.why || '').slice(0, 70) : p.addedBy));
  for (const p of Object.values(m.pending || {})) console.log('pending ' + p.ecosystem + ' ' + p.name + '==' + p.version + ' — owner question ' + p.questionId);
  return 0;
}
function runBin(name, args) {
  if (!name || name.includes('/')) throw new Usage('run <bin> [args...]: the name of an installed CLI (ls company/env/bin)');
  const f = path.join(F.bin, name);
  if (!fs.existsSync(f)) throw new Refusal('"' + name + '" is not installed in the company environment (node company/tools/deps.js list; add it with deps.js add)', 1);
  const env = Object.assign({}, process.env, { PATH: F.bin + path.delimiter + (process.env.PATH || '') });
  const py = current(PY.link); if (py) env.VIRTUAL_ENV = py;
  const r = cp.spawnSync(f, args, { stdio: 'inherit', env });
  if (r.error) throw new Refusal('could not start ' + name + ': ' + r.error.message, 1);
  return r.status == null ? 1 : r.status;
}

/* ---------------- CLI ---------------- */
function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const eq = k.indexOf('='); if (eq > 0) o[k.slice(0, eq)] = k.slice(eq + 1); else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) o[k] = argv[++i]; else o[k] = true; }
    else o._.push(a);
  }
  return o;
}
function main(argv) {
  if (argv[0] === 'run') return runBin(argv[1], argv.slice(2));
  if (argv[0] === '--duty' || (argv[0] === 'verify' && argv.includes('--duty'))) return duty();
  const a = parseArgs(argv); const cmd = a._[0];
  if (cmd === 'add') { add(a._[1], a._[2], a); return 0; }
  // adopt: an ad hoc install (pipx, pip --user, npm -g) made the company's: the same package through deps.js (pinned,
  // hashed, checked), then the ad hoc install is settled. Remove the ad hoc copy afterwards (pipx uninstall <pkg>).
  if (cmd === 'adopt') { const r = add(a._[1], a._[2], Object.assign({}, a, { why: a.why || 'adopted from an ad hoc install' })); settle(String(a._[2] || ''), Object.assign({}, a, { why: a.why || 'adopted into deps.js' }), 'adopted into deps.js'); return r && typeof r.then === 'function' ? r.then(() => 0) : 0; }
  if (cmd === 'settle') { console.log(JSON.stringify(settle(a._[1], a))); return 0; }
  if (cmd === 'remove') { if (!a._[1]) throw new Usage('remove <package> --by <seat>'); remove(a._[1], a); return 0; }
  if (cmd === 'list') return list(!!a.json);
  if (cmd === 'verify') return verify(a);
  if (cmd === 'approve') { approve(a._[1], a._[2], a._[3], a); return 0; }
  if (cmd === 'selftest' || a.selftest) return require('./tests/deps-selftest.js').selftest();   // a promise of the exit code
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 12).map(l => l.replace(/^ \* ?/, '')).join('\n'));
  return cmd ? 2 : 0;
}

module.exports = { ASKS, adhocPackage, openAdhoc, dutyReason, classifyLicence, typoOf, isAdhoc, ADHOC_INSTALL, pyLicenceText, REGISTRIES, ECOSYSTEMS, distance };

if (require.main === module) {
  let code;
  try { code = main(process.argv.slice(2)); }
  catch (e) { if (e instanceof Refusal || e instanceof Usage) { console.error(e.message); code = e.code; } else { console.error('deps.js: ' + (e && e.stack || e)); code = 1; } }
  if (code && typeof code.then === 'function') code.then(c => { process.exitCode = c; }, e => { console.error(e); process.exitCode = 1; });
  else process.exitCode = code;
}
