'use strict';
/* deps-selftest.js — `node company/tools/deps.js selftest`. Offline: a fake PyPI + npm registry served from a temp folder
 * on a loopback port (no other network), a scratch company with a copy of company/tools, and every deps.js command run
 * as a child process the way an agent runs it. Cases: add, pin, run, verify and rebuild; licence (risk) and AGPL
 * (owner) refusal; the age guard; the typosquat guard; no-wheel and install-script refusals naming the package;
 * governance notify vs approve; locked-watch quiet after deps.js writes; a lock edited outside the tool is refused and
 * flagged; an interrupted install leaves the previous env running; the read-only duty; ad hoc installs in transcripts;
 * a backup/restore round trip rebuilds the env from the lock; nothing is written outside the company tree. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const cp = require('child_process');
const assert = require('assert');

const TOOLS = path.resolve(__dirname, '..');
const REPO = path.resolve(TOOLS, '..', '..');
const OLD = '2020-01-01T00:00:00Z';

const WHEEL_PY = `
import sys, json, zipfile, hashlib, base64, os
spec = json.loads(sys.argv[1]); out = sys.argv[2]
for p in spec:
    name, ver = p['name'], p['version']; mod = name.replace('-', '_')
    files = {mod + '/__init__.py': "__version__ = '%s'\\n" % ver}
    if p.get('cli'): files[mod + '/cli.py'] = "def main():\\n    print('%s %s')\\n" % (name, ver)
    di = '%s-%s.dist-info' % (mod, ver)
    files[di + '/METADATA'] = 'Metadata-Version: 2.1\\nName: %s\\nVersion: %s\\nLicense: %s\\n' % (name, ver, p.get('license', '')) + ''.join('Requires-Dist: %s\\n' % r for r in p.get('requires', []))
    files[di + '/WHEEL'] = 'Wheel-Version: 1.0\\nGenerator: deps-selftest\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n'
    if p.get('cli'): files[di + '/entry_points.txt'] = '[console_scripts]\\n%s = %s.cli:main\\n' % (p['cli'], mod)
    rec = []
    for k, v in files.items():
        d = base64.urlsafe_b64encode(hashlib.sha256(v.encode()).digest()).rstrip(b'=').decode()
        rec.append('%s,sha256=%s,%d' % (k, d, len(v.encode())))
    rec.append(di + '/RECORD,,')
    files[di + '/RECORD'] = '\\n'.join(rec) + '\\n'
    with zipfile.ZipFile(os.path.join(out, '%s-%s-py3-none-any.whl' % (mod, ver)), 'w') as z:
        for k, v in files.items(): z.writestr(zipfile.ZipInfo(k, (2020, 1, 1, 0, 0, 0)), v)
`;

const SERVER_JS = `
  const http = require('http'), fs = require('fs'), path = require('path');
  const RG = process.argv[1];
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    const base = 'http://127.0.0.1:' + srv.address().port;
    let f = null, type = 'application/json', m;
    if ((m = /^\\/pypi\\/([^/]+)\\/json$/.exec(u))) f = path.join(RG, 'pypi', m[1], 'latest.json');
    else if ((m = /^\\/pypi\\/([^/]+)\\/([^/]+)\\/json$/.exec(u))) f = path.join(RG, 'pypi', m[1], m[2] + '.json');
    else if ((m = /^\\/simple\\/([^/]+)\\/?$/.exec(u))) { f = path.join(RG, 'simple', m[1] + '.html'); type = 'text/html'; }
    else if ((m = /^\\/files\\/([^/]+)$/.exec(u))) { f = path.join(RG, 'files', m[1]); type = 'application/octet-stream'; }
    else if ((m = /^\\/npm\\/-\\/([^/]+)$/.exec(u))) { f = path.join(RG, 'npm-files', m[1]); type = 'application/octet-stream'; }
    else if ((m = /^\\/npm\\/(.+)$/.exec(u))) f = path.join(RG, 'npm', m[1].replace('/', '__') + '.json');
    let body; try { body = fs.readFileSync(f); } catch (_) { res.writeHead(404); return res.end('not found'); }
    if (type !== 'application/octet-stream') body = Buffer.from(body.toString('utf8').split('{{BASE}}').join(base));
    res.writeHead(200, { 'content-type': type }); res.end(body);
  });
  srv.listen(0, '127.0.0.1', () => process.stdout.write(String(srv.address().port) + '\\n'));
`;

function mk(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function w(f, v) { mk(path.dirname(f)); fs.writeFileSync(f, typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v, null, 1)); return f; }
const shaHex = b => crypto.createHash('sha256').update(b).digest('hex');
function treeHash(dir, skip) {
  const out = {};
  const walk = (d, r) => { let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; } for (const e of ents) { const f = path.join(d, e.name), rr = r ? r + '/' + e.name : e.name; if (skip && skip(rr)) continue; if (e.isSymbolicLink()) out[rr] = 'link:' + fs.readlinkSync(f); else if (e.isDirectory()) walk(f, rr); else if (e.isFile()) out[rr] = shaHex(fs.readFileSync(f)); } };
  walk(dir, ''); return out;
}

// the fake registry: python wheels + PyPI JSON + a simple index; npm tarballs + packuments
function buildRegistry(RG) {
  const now = new Date(Date.now() - 3600e3).toISOString();
  const py = [
    { name: 'fakecli', version: '1.0.0', license: 'MIT', cli: 'fakecli', requires: ['fakedep'], up: OLD },
    { name: 'fakecli', version: '1.1.0', license: 'MIT', cli: 'fakecli', requires: ['fakedep'], up: OLD },
    { name: 'fakedep', version: '2.0.0', license: 'BSD-3-Clause', up: OLD },
    { name: 'gplpkg', version: '1.0.0', license: 'GPL-3.0-only', up: OLD },
    { name: 'agplpkg', version: '1.0.0', license: 'AGPL-3.0-or-later', up: OLD },
    { name: 'newpkg', version: '1.0.0', license: 'MIT', up: now },
    { name: 'reqeusts', version: '1.0.0', license: 'MIT', up: OLD },
    { name: 'otherpkg', version: '1.0.0', license: 'Apache-2.0', up: OLD },
  ];
  mk(path.join(RG, 'files'));
  const r = cp.spawnSync('python3', ['-I', '-c', WHEEL_PY, JSON.stringify(py), path.join(RG, 'files')], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('wheel build failed: ' + r.stderr);
  const byName = {};
  for (const p of py) {
    const fn = p.name.replace(/-/g, '_') + '-' + p.version + '-py3-none-any.whl';
    const hex = shaHex(fs.readFileSync(path.join(RG, 'files', fn)));
    const doc = { info: { name: p.name, version: p.version, license_expression: p.license, author: 'Test Author', home_page: 'https://example.invalid/' + p.name, classifiers: [] },
      urls: [{ filename: fn, url: '{{BASE}}/files/' + fn, packagetype: 'bdist_wheel', digests: { sha256: hex }, upload_time_iso_8601: p.up, yanked: false }] };
    w(path.join(RG, 'pypi', p.name, p.version + '.json'), doc);
    (byName[p.name] = byName[p.name] || []).push({ fn, hex, doc });
  }
  // an sdist-only package: the simple index lists only a .tar.gz, so --only-binary finds nothing
  w(path.join(RG, 'files', 'sdistonly-1.0.0.tar.gz'), 'not really a tarball');
  const sdHex = shaHex(fs.readFileSync(path.join(RG, 'files', 'sdistonly-1.0.0.tar.gz')));
  const sdDoc = { info: { name: 'sdistonly', version: '1.0.0', license_expression: 'MIT', author: 'T' }, urls: [{ filename: 'sdistonly-1.0.0.tar.gz', url: '{{BASE}}/files/sdistonly-1.0.0.tar.gz', packagetype: 'sdist', digests: { sha256: sdHex }, upload_time_iso_8601: OLD }] };
  w(path.join(RG, 'pypi', 'sdistonly', '1.0.0.json'), sdDoc); w(path.join(RG, 'pypi', 'sdistonly', 'latest.json'), sdDoc);
  w(path.join(RG, 'simple', 'sdistonly.html'), '<html><body><a href="{{BASE}}/files/sdistonly-1.0.0.tar.gz#sha256=' + sdHex + '">sdistonly-1.0.0.tar.gz</a></body></html>');
  for (const [n, list] of Object.entries(byName)) {
    w(path.join(RG, 'pypi', n, 'latest.json'), list[list.length - 1].doc);
    w(path.join(RG, 'simple', n + '.html'), '<html><body>' + list.map(x => '<a href="{{BASE}}/files/' + x.fn + '#sha256=' + x.hex + '">' + x.fn + '</a>').join('\n') + '</body></html>');
  }
  // npm
  const npm = [
    { name: 'fakenode', version: '1.0.0', bin: true },
    { name: 'scriptpkg', version: '1.0.0', scripts: { postinstall: 'node -e "require(\'fs\').writeFileSync(\'/tmp/deps-selftest-postinstall-RAN\', \'1\')"' } },
  ];
  for (const p of npm) {
    const d = mk(path.join(RG, 'build', p.name, 'package'));
    const pj = { name: p.name, version: p.version, license: 'MIT' };
    if (p.bin) { pj.bin = { [p.name]: 'cli.js' }; fs.writeFileSync(path.join(d, 'cli.js'), '#!/usr/bin/env node\nconsole.log(' + JSON.stringify(p.name + ' ' + p.version) + ');\n', { mode: 0o755 }); }
    if (p.scripts) pj.scripts = p.scripts;
    w(path.join(d, 'package.json'), pj);
    const tgz = path.join(mk(path.join(RG, 'npm-files')), p.name + '-' + p.version + '.tgz');
    const t = cp.spawnSync('tar', ['--mtime=2020-01-01', '-czf', tgz, '-C', path.dirname(d), 'package']); if (t.status !== 0) throw new Error('tar failed');
    const buf = fs.readFileSync(tgz);
    const v = Object.assign({}, pj, { dist: { tarball: '{{BASE}}/npm/-/' + path.basename(tgz), integrity: 'sha512-' + crypto.createHash('sha512').update(buf).digest('base64'), shasum: crypto.createHash('sha1').update(buf).digest('hex') } });
    if (p.scripts) v.hasInstallScript = true;
    w(path.join(RG, 'npm', p.name + '.json'), { name: p.name, 'dist-tags': { latest: p.version }, versions: { [p.version]: v }, time: { created: OLD, modified: OLD, [p.version]: OLD }, maintainers: [{ name: 'tester' }], license: 'MIT' });
  }
}

async function selftest() {
  const results = []; let bad = 0;
  const t = async (name, fn) => { try { await fn(); results.push('ok   ' + name); } catch (e) { bad++; results.push('FAIL ' + name + ': ' + (e && e.message ? e.message : e).toString().split('\n').slice(0, 8).join(' | ')); } };

  // unit checks (no processes)
  const D = require('../deps.js');
  await t('licence classes: permissive allow, GPL and unknown need risk, AGPL needs the owner, OR takes the best', () => {
    for (const l of ['MIT', 'BSD-3-Clause', 'Apache-2.0', 'ISC', 'MPL-2.0', 'MIT License', 'Apache Software License', 'PSF-2.0', 'GPL-3.0-only OR MIT']) assert.strictEqual(D.classifyLicence(l).cls, 'allow', l);
    for (const l of ['GPL-3.0-only', 'LGPL-2.1', '', 'UNKNOWN', 'Some Custom Terms', 'MIT AND GPL-2.0']) assert.strictEqual(D.classifyLicence(l).cls, 'risk', l);
    for (const l of ['AGPL-3.0-or-later', 'GNU Affero General Public License v3', 'SSPL-1.0']) assert.strictEqual(D.classifyLicence(l).cls, 'owner', l);
  });
  await t('typosquat guard: near-misses of popular names, not the names themselves', () => {
    assert.strictEqual(D.typoOf('python', 'reqeusts'), 'requests'); assert.strictEqual(D.typoOf('node', 'lodahs'), 'lodash'); assert.strictEqual(D.typoOf('node', 'expres'), 'express');
    assert.strictEqual(D.typoOf('python', 'requests'), null); assert.strictEqual(D.typoOf('python', 'synpath'), null); assert.strictEqual(D.typoOf('node', 'fakenode'), null);
  });
  await t('ad hoc install detector: named pip installs, --user, global npm, pipx, system managers; not -r, -e, deps.js or a local npm install', () => {
    for (const c of ['pip install synpath==0.11.0', 'scratch/synpathenv/bin/pip install synpath', 'python3 -m pip install --upgrade requests', 'pip3 install --user -r req.txt', 'pip install --break-system-packages x',
      'npm install -g typescript', 'npm i --global pm2', 'pipx install black', 'uv tool install ruff', 'sudo apt-get install -y ffmpeg', 'yarn global add serve']) assert.ok(D.isAdhoc(c), c);
    for (const c of ['pip install -r requirements.txt', 'pip install -e .', 'npm install', 'npm ci', 'cd app && npm install lodash', 'node company/tools/deps.js add python synpath --why x --by y', 'echo "never pip install"x | grep pip']) assert.ok(!D.isAdhoc(c), c);
  });

  await t('ad hoc installs: the package is named, a settled one is not reported again (a later install is), and the fix says what to do (never the owner)', () => {
    assert.strictEqual(D.adhocPackage('pipx install synpath-cli'), 'synpath-cli'); assert.strictEqual(D.adhocPackage('pip install --user requests==2.31.0'), 'requests');
    assert.strictEqual(D.adhocPackage('npm i --global pm2@5.3.0'), 'pm2'); assert.strictEqual(D.adhocPackage('uv tool install ruff'), 'ruff');
    const seen = [{ runId: 'r1', pkg: 'synpath-cli', ts: Date.parse('2030-01-01T10:00:00Z') }, { runId: 'r2', pkg: 'black', ts: Date.parse('2030-01-01T10:00:00Z') }];
    const open = D.openAdhoc(seen, { adhocSettled: { 'synpath-cli': { at: '2030-01-01T11:00:00Z' } } });
    assert.deepStrictEqual(open.map(a => a.runId), ['r2']);
    assert.strictEqual(D.openAdhoc([{ runId: 'r3', pkg: 'synpath-cli', ts: Date.parse('2030-01-02T10:00:00Z') }], { adhocSettled: { 'synpath-cli': { at: '2030-01-01T11:00:00Z' } } }).length, 1, 'an install after the settle is new');
    const r = D.dutyReason(['1 ad hoc install(s) outside deps.js in 24 h (synpath-cli)'], { adhoc: true });
    assert.ok(/deps\.js adopt <python\|node> <package>==<version>/.test(r) && /deps\.js settle/.test(r) && /Not an owner question/.test(r) && !/Fix: node company\/tools\/deps\.js verify\b(?! --rebuild)/.test(r), r);
  });

  const T = require('../lib/temp-life').tmpDir('deps-selftest-');
  const H = mk(path.join(T, 'outside-home'));           // HOME of every child: must stay empty
  const LWH = mk(path.join(T, 'outside-lw'));            // locked-watch's own mirror home (it writes there by design)
  const BK = mk(path.join(T, 'outside-backups'));
  const RG = mk(path.join(T, 'outside-registry'));
  const C = mk(path.join(T, 'co'));                      // the company root
  let server = null;
  try {
    buildRegistry(RG);
    // a scratch company: a copy of the tools (so provenance names company/tools/deps.js), crew, governance defaults
    fs.cpSync(TOOLS, path.join(C, 'company', 'tools'), { recursive: true, filter: s => !s.includes(path.sep + 'tests' + path.sep) || s.endsWith('deps-selftest.js') });
    fs.cpSync(path.join(REPO, 'company', 'defaults'), path.join(C, 'company', 'defaults'), { recursive: true });
    w(path.join(C, 'scripts', 'backup.sh'), fs.readFileSync(path.join(REPO, 'scripts', 'backup.sh')));
    w(path.join(C, 'company', 'company.json'), { name: 'Deps Test', slug: 'deps-selftest', owner: { name: 'Pat' }, timezone: 'UTC', station: { port: 1 } });
    w(path.join(C, 'company', 'tools', 'loops.json'), { agents: { a: { name: 'Alex', functions: ['ceo'], manager: null, inbox: 'to-alex.md' }, k: { name: 'Kim', functions: ['tools'], manager: 'a', inbox: 'to-kim.md' }, r: { name: 'Riley', functions: ['risk'], manager: 'a', inbox: 'to-riley.md' } } });
    w(path.join(C, 'company', 'state', 'governance.json'), fs.readFileSync(path.join(REPO, 'company', 'defaults', 'state', 'governance.json')));
    mk(path.join(C, 'company', 'work', 'handoffs'));

    // the registry server (a separate process; the children reach it over loopback)
    server = require('../lib/temp-life').track(cp.spawn(process.execPath, ['-e', SERVER_JS, RG], { stdio: ['ignore', 'pipe', 'inherit'] }));
    const port = await new Promise((res, rej) => { let s = ''; server.stdout.on('data', b => { s += b; if (s.includes('\n')) res(Number(s.trim())); }); server.on('exit', c => rej(new Error('registry server exited ' + c))); setTimeout(() => rej(new Error('registry server did not start')), 10000); });
    const REG = 'http://127.0.0.1:' + port;

    const before = { home: treeHash(H), top: fs.readdirSync(C).sort() };
    const lw = require(path.join(C, 'company', 'tools', 'locked-watch.js'));
    const lwCtx = now => ({ root: C, home: LWH, now, log: () => {}, underStation: false, ownerShell: false, jobs: [] });
    process.env.PROVENANCE_ROOT = C;
    await lw.tick(lwCtx(Date.now()));   // baseline before any deps.js write

    const deps = (args, extra) => {
      const env = Object.assign({ PATH: process.env.PATH, HOME: H, TZ: 'UTC', CAPHEOS_ROOT: C, STARNET_URL: 'http://127.0.0.1:1', DEPS_REGISTRY_URL: REG }, extra || {});
      const r = cp.spawnSync(process.execPath, [path.join(C, 'company', 'tools', 'deps.js')].concat(args), { encoding: 'utf8', env, cwd: C, timeout: 300000 });
      return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '' };
    };
    const manifest = () => JSON.parse(fs.readFileSync(path.join(C, 'company', 'state', 'deps.json'), 'utf8'));
    const R = f => { try { return fs.readFileSync(path.join(C, f), 'utf8'); } catch (_) { return ''; } };
    const expect = (r, code, re, what) => { assert.strictEqual(r.code, code, what + ': exit ' + r.code + ' ' + r.out.slice(-600)); if (re) assert.match(r.out, re, what); };

    await t('a new registry (the loopback fake) is refused until the risk seat approves it; a non-risk seat cannot', () => {
      expect(deps(['add', 'python', 'fakecli', '--why', 'the fake CLI', '--by', 'Kim']), 3, /approve registry python loopback/, 'unapproved registry');
      expect(deps(['approve', 'registry', 'python', 'loopback', '--by', 'Kim', '--why', 'x']), 3, /only the risk seat/, 'Kim approving');
      expect(deps(['approve', 'registry', 'python', 'loopback', '--by', 'Riley', '--why', 'the selftest registry']), 0, null, 'risk approves');
      expect(deps(['approve', 'registry', 'node', 'loopback', '--by', 'Riley', '--why', 'the selftest registry']), 0, null, 'risk approves node');
    });
    await t('add: "latest" pinned to an exact version, the tree hash-pinned from the registry, notify tells the risk seat', () => {
      expect(deps(['add', 'python', 'fakecli', '--why', 'the fake CLI', '--by', 'Kim']), 0, /added python fakecli==1\.1\.0/, 'add');
      const m = manifest();
      assert.strictEqual(m.packages['python:fakecli'].version, '1.1.0'); assert.ok(m.packages['python:fakecli'].direct);
      assert.ok(m.packages['python:fakedep'] && !m.packages['python:fakedep'].direct, 'transitive recorded');
      assert.match(m.packages['python:fakecli'].hashes[0], /^sha256:[0-9a-f]{64}$/); assert.strictEqual(m.packages['python:fakecli'].licence, 'MIT');
      const lock = R('company/state/deps/python.lock');
      assert.match(lock, /^fakecli==1\.1\.0 \\\n    --hash=sha256:[0-9a-f]{64}/m); assert.match(lock, /^fakedep==2\.0\.0/m);
      assert.match(R('company/work/handoffs/to-riley.md'), /FYI: Kim added python fakecli==1\.1\.0 \(MIT\)/);
      assert.ok(fs.lstatSync(path.join(C, 'company/env/python')).isSymbolicLink(), 'env is a generation behind a symlink');
    });
    await t('run finds the CLI in the company environment; the bin dir holds it', () => {
      const r = deps(['run', 'fakecli']); expect(r, 0, /fakecli 1\.1\.0/, 'run');
      assert.ok(fs.existsSync(path.join(C, 'company/env/bin/fakecli')));
      expect(deps(['run', 'nosuch']), 1, /not installed/, 'missing bin');
    });
    await t('licence: GPL needs the risk seat, AGPL needs the owner (an owner question); nothing installed', () => {
      expect(deps(['add', 'python', 'gplpkg', '--why', 'x', '--by', 'Kim']), 3, /GPL-3\.0-only.*needs the risk seat's approval/, 'gpl');
      const r = deps(['add', 'python', 'agplpkg', '--why', 'x', '--by', 'Kim']); expect(r, 3, /needs the owner/, 'agpl');
      assert.match(R('company/pm-inbox.jsonl'), /deps:agpl:python:agplpkg==1\.0\.0/);
      assert.ok(!manifest().packages['python:gplpkg'] && !manifest().packages['python:agplpkg']);
      expect(deps(['run', 'fakecli']), 0, /fakecli 1\.1\.0/, 'env untouched');
    });
    await t('age guard: a version published an hour ago is refused until risk approves that exact version', () => {
      expect(deps(['add', 'python', 'newpkg', '--why', 'x', '--by', 'Kim']), 3, /published 0\.\d days ago.*risk seat/, 'new');
      expect(deps(['approve', 'age', 'python', 'newpkg==1.0.0', '--by', 'Riley', '--why', 'reviewed the diff']), 0, null, 'approve age');
      expect(deps(['add', 'python', 'newpkg', '--why', 'x', '--by', 'Kim']), 0, /added python newpkg==1\.0\.0/, 'after approval');
    });
    await t('typosquat: a near-miss of a popular name needs the risk seat', () => {
      expect(deps(['add', 'python', 'reqeusts', '--why', 'x', '--by', 'Kim']), 3, /popular "requests".*risk seat/, 'typo');
    });
    await t('no wheel (it would run build scripts) is refused, naming the package', () => {
      expect(deps(['add', 'python', 'sdistonly', '--why', 'x', '--by', 'Kim']), 3, /sdistonly: no wheel.*approve scripts python sdistonly/, 'sdist');
    });
    await t('node: add + run; a postinstall package not on the allow-list is refused, naming it, and its script never runs', () => {
      try { fs.rmSync('/tmp/deps-selftest-postinstall-RAN', { force: true }); } catch (_) {}
      expect(deps(['add', 'node', 'fakenode', '--why', 'the fake node CLI', '--by', 'Kim']), 0, /added node fakenode==1\.0\.0/, 'add node');
      expect(deps(['run', 'fakenode']), 0, /fakenode 1\.0\.0/, 'run node');
      assert.match(R('company/state/deps/node/package-lock.json'), /"integrity": "sha512-/);
      expect(deps(['add', 'node', 'scriptpkg', '--why', 'x', '--by', 'Kim']), 3, /scriptpkg==1\.0\.0 runs install or build scripts/, 'postinstall');
      assert.ok(!fs.existsSync('/tmp/deps-selftest-postinstall-RAN'), 'the postinstall ran');
      assert.ok(!manifest().packages['node:scriptpkg']);
    });
    const gf = path.join(C, 'company/state/governance.json'); const g0 = fs.readFileSync(gf);
    await t('governance approve: an owner question with an Approve button; after yes, verify installs it', () => {
      const g = JSON.parse(g0.toString()); g.categories.deps = 'approve'; fs.writeFileSync(gf, JSON.stringify(g));
      const r = deps(['add', 'python', 'otherpkg', '--why', 'needed for the report', '--by', 'Kim']); expect(r, 3, /waits for the owner \(question (q-\d+)/, 'approve');
      const qid = /question (q-\d+)/.exec(r.out)[1];
      assert.ok(manifest().pending['deps:add:python:otherpkg==1.0.0'], 'pending recorded');
      const duty = deps(['--duty']); assert.strictEqual(duty.code, 0, 'nothing due while unanswered: ' + duty.out);
      // the owner's Approve, written the way the owner's tools write it (recorded first: lib/pm-inbox-guard.js)
      require(path.join(C, 'company/tools/lib/pm-inbox-guard.js')).append(path.join(C, 'company/pm-inbox.jsonl'), { type: 'answer', id: qid, at: new Date().toISOString(), a: 'yes', by: 'Pat', answer: { verdict: 'yes' } }, 'selftest', { root: C });
      const d2 = deps(['--duty']); assert.strictEqual(d2.code, 1); assert.match(d2.stdout, /deps:pending:q-\d+.*"route":"k"/);
      expect(deps(['verify']), 0, /otherpkg: approved by the owner, installed/, 'verify completes');
      assert.ok(manifest().packages['python:otherpkg'] && !Object.keys(manifest().pending).length);
    });
    fs.writeFileSync(gf, g0);
    await t('locked-watch is quiet after deps.js writes (manifest and locks are recorded writes)', async () => {
      const r = await lw.tick(lwCtx(Date.now() + 60000));
      const ev = (r.events || []).filter(e => /deps/.test(String(e.key || e.file || '')));
      assert.strictEqual(ev.length, 0, JSON.stringify(ev).slice(0, 400));
    });
    await t('a lock edited outside the tool is refused at verify and add, and flagged to the risk seat', () => {
      const lf = path.join(C, 'company/state/deps/python.lock'); const orig = fs.readFileSync(lf);
      fs.appendFileSync(lf, 'evil==6.6.6 --hash=sha256:' + '0'.repeat(64) + '\n');
      expect(deps(['verify']), 3, /python\.lock was changed outside deps\.js/, 'verify refuses');
      expect(deps(['add', 'python', 'otherpkg', '--why', 'x', '--by', 'Kim']), 3, /changed outside deps\.js/, 'add refuses');
      assert.match(R('company/work/handoffs/to-riley.md'), /edited outside deps\.js/);
      const d = deps(['--duty']); assert.strictEqual(d.code, 1); assert.match(d.stdout, /deps:tampered.*risk/);
      fs.writeFileSync(lf, orig);
      expect(deps(['verify']), 0, /python: ok/, 'restored');
    });
    await t('an interrupted install leaves the previous env running and the lock unchanged', () => {
      const lock = R('company/state/deps/python.lock');
      const r = deps(['add', 'python', 'fakecli==1.0.0', '--why', 'downgrade', '--by', 'Kim'], { DEPS_TEST_CRASH: 'before-swap' }); assert.strictEqual(r.code, 9, r.out);
      expect(deps(['run', 'fakecli']), 0, /fakecli 1\.1\.0/, 'old env still runs');
      assert.strictEqual(R('company/state/deps/python.lock'), lock); assert.strictEqual(manifest().packages['python:fakecli'].version, '1.1.0');
      expect(deps(['verify']), 0, /python: ok/, 'verify after crash');
    });
    await t('verify rebuilds a missing env from the lock, and a second run needs no network', () => {
      fs.rmSync(path.join(C, 'company/env'), { recursive: true, force: true });
      const d = deps(['--duty']); assert.strictEqual(d.code, 1); assert.match(d.stdout, /deps:env:python.*"route":"tools"/);
      expect(deps(['verify', '--rebuild']), 0, /python: missing — rebuilt from the lock.*\n?.*node: missing — rebuilt/s, 'rebuild');
      expect(deps(['run', 'fakecli']), 0, /fakecli 1\.1\.0/, 'after rebuild');
      const r2 = deps(['verify', '--rebuild'], { DEPS_REGISTRY_URL: 'http://127.0.0.1:9' }); expect(r2, 0, /python: ok, matches the lock/, 'idempotent, offline');
    });
    await t('the duty is read-only, and quiet when everything matches', () => {
      const h0 = treeHash(C); const d = deps(['--duty']); assert.strictEqual(d.code, 0, d.out); assert.deepStrictEqual(treeHash(C), h0);
    });
    await t('the duty reports an ad hoc pip install seen in a transcript, to the risk seat', () => {
      const seg = path.join(C, '.starnet-data/workspaces/transcript-history-v2/segment-000001.jsonl');
      w(seg, JSON.stringify({ agentId: 'k', sourceRunId: 'run-k-abcdef', ts: Date.now(), toolCalls: JSON.stringify([{ function: { name: 'shell_exec', arguments: JSON.stringify({ command: 'scratch/venv/bin/pip install synpath==0.11.0' }) } }]) }) + '\n');
      const d = deps(['--duty']); assert.strictEqual(d.code, 1); assert.match(d.stdout, /deps:adhoc:run-k-abcdef.*"route":"risk"/);
      fs.rmSync(path.join(C, '.starnet-data'), { recursive: true, force: true });
    });
    await t('backup holds the lock and hashes, never the env; restore on a new machine rebuilds the env from the lock', () => {
      const b = cp.spawnSync('bash', [path.join(C, 'scripts/backup.sh')], { encoding: 'utf8', cwd: C, env: { PATH: process.env.PATH, HOME: H, CAPHEOS_BACKUP_DIR: BK } });
      assert.strictEqual(b.status, 0, b.stdout + b.stderr);
      const snap = fs.readdirSync(BK).filter(f => f.endsWith('.tar.gz'))[0];
      const list = cp.spawnSync('tar', ['-tzf', path.join(BK, snap)], { encoding: 'utf8' }).stdout;
      assert.ok(/company\/state\/deps\/python\.lock/.test(list) && /company\/state\/deps\.json/.test(list), 'lock in the snapshot');
      assert.ok(!/company\/env\//.test(list), 'no environment in the snapshot');
      const C2 = mk(path.join(T, 'co2'));
      fs.cpSync(path.join(C, 'company', 'tools'), path.join(C2, 'company', 'tools'), { recursive: true });
      fs.cpSync(path.join(C, 'company', 'defaults'), path.join(C2, 'company', 'defaults'), { recursive: true });
      fs.cpSync(path.join(C, 'company', 'company.json'), path.join(C2, 'company', 'company.json'));
      w(path.join(C2, 'scripts', 'backup.sh'), fs.readFileSync(path.join(C, 'scripts/backup.sh')));
      const rs = cp.spawnSync('bash', [path.join(C2, 'scripts/backup.sh'), 'restore', snap, '--force'], { encoding: 'utf8', cwd: C2, env: { PATH: process.env.PATH, HOME: H, CAPHEOS_BACKUP_DIR: BK, CAPHEOS_ROOT: C2, STARNET_URL: 'http://127.0.0.1:1', DEPS_REGISTRY_URL: REG } });
      assert.strictEqual(rs.status, 0, rs.stdout + rs.stderr); assert.match(rs.stdout, /rebuilt from the lock/);
      assert.strictEqual(fs.readFileSync(path.join(C2, 'company/state/deps/python.lock'), 'utf8'), R('company/state/deps/python.lock'));
      const r = cp.spawnSync(process.execPath, [path.join(C2, 'company/tools/deps.js'), 'run', 'fakecli'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: H, CAPHEOS_ROOT: C2 } });
      assert.match(r.stdout, /fakecli 1\.1\.0/);
      // the installed wheel is the hashed one: its RECORD's own hash list came from the bytes pip checked against the lock
      const m2 = JSON.parse(fs.readFileSync(path.join(C2, 'company/state/deps.json'), 'utf8'));
      assert.deepStrictEqual(m2.packages['python:fakecli'].hashes, manifest().packages['python:fakecli'].hashes);
    });
    await t('remove takes the package and its now-unused dependencies out, and the CLI link', () => {
      expect(deps(['remove', 'fakecli', '--by', 'Kim']), 0, /removed python fakecli==1\.1\.0/, 'remove');
      const m = manifest(); assert.ok(!m.packages['python:fakecli'] && !m.packages['python:fakedep'] && m.packages['python:newpkg']);
      assert.ok(!fs.existsSync(path.join(C, 'company/env/bin/fakecli')));
    });
    await t('system packages are refused with the owner sentence and a plain-words owner question', () => {
      expect(deps(['add', 'apt', 'ffmpeg', '--why', 'video thumbnails', '--by', 'Kim']), 3, /needs the owner: system packages install on the host/, 'system');
      assert.match(R('company/pm-inbox.jsonl'), /deps:system:ffmpeg/); assert.doesNotMatch(R('company/pm-inbox.jsonl').split('\n').filter(l => l.includes('deps:system')).join(''), /sudo|apt-get install/);
    });
    await t('nothing was written outside the company tree (HOME stays empty; no new top-level entries)', () => {
      assert.deepStrictEqual(treeHash(H), before.home);
      assert.deepStrictEqual(fs.readdirSync(C).sort().filter(n => n !== '.starnet-data'), before.top);
    });
  } catch (e) { bad++; results.push('FAIL setup: ' + (e && e.stack || e)); }
  finally {
    if (server) server.kill();
    delete process.env.PROVENANCE_ROOT;
    try { fs.rmSync(T, { recursive: true, force: true }); } catch (_) {}
  }
  for (const r of results) console.log(r);
  console.log(bad ? 'DEPS SELFTEST FAILED: ' + bad : 'DEPS SELFTEST PASSED (' + results.length + ' checks)');
  return bad ? 1 : 0;
}
module.exports = { selftest };
