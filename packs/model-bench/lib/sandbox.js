'use strict';
/* Sandboxes for the task instances (spec section 6).
 *
 * Each instance gets <company root>/company/work/units/model-bench/sandbox/<runId>/<taskId>/ with work/ (the workspace
 * the model sees, mounted at /work) and tmp/ (its /tmp). Never the system /tmp, which is RAM on small hosts. Removed
 * when the instance is scored; a crashed run's folders are swept on the next start (sweep()).
 *
 * Engines: docker (--network none --read-only, memory/cpu/pids caps, the pinned bench image) or bwrap (--unshare-all, so no
 * network, a cleared environment, only /usr and the toolchains read-only). With neither, a sandboxed task is REFUSED: a
 * model's commands never run on the host. The one host engine, 'trusted', runs only our own oracle actions and check
 * scripts in conformance tests, and the runner refuses it for a model.
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SAFE_PATH = '/usr/local/bin:/usr/bin:/bin';
const BENCH_GIT_ENV = { GIT_AUTHOR_NAME: 'Bench Runner', GIT_AUTHOR_EMAIL: 'bench@example.invalid', GIT_COMMITTER_NAME: 'Bench Runner',
  GIT_COMMITTER_EMAIL: 'bench@example.invalid', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LANG: 'C.UTF-8', TZ: 'UTC' };

function baseDir(root) { return path.join(root, 'company', 'work', 'units', 'model-bench', 'sandbox'); }
function which(bin) {
  for (const d of (process.env.PATH || '').split(':')) { if (!d) continue; const p = path.join(d, bin); try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) {} }
  return null;
}
// toolchain folders outside /usr that must be visible read-only (node, dart): the real folder of each binary's tree
// the real Dart SDK (a Flutter checkout's `dart` is a wrapper that writes into the SDK cache; the SDK binary is not)
function dartBin() {
  const d = which('dart'); if (!d) return null;
  try {
    const real = fs.realpathSync(d);
    const sdkBin = path.join(path.dirname(real), 'cache', 'dart-sdk', 'bin', 'dart');
    return fs.existsSync(sdkBin) ? sdkBin : real;
  } catch (_) { return null; }
}
// toolchain folders outside /usr that must be visible read-only (node, the Dart SDK)
function toolDirs() {
  const out = new Set();
  const nodeDir = path.dirname(fs.realpathSync(process.execPath));
  if (!nodeDir.startsWith('/usr/')) out.add(path.dirname(nodeDir));
  const dart = dartBin(); if (dart && !dart.startsWith('/usr/')) out.add(path.resolve(path.dirname(dart), '..'));
  return [...out];
}
function toolPath() {
  const dirs = [path.dirname(fs.realpathSync(process.execPath))];
  const dart = dartBin(); if (dart) dirs.push(path.dirname(dart));
  return [...new Set(dirs.filter(d => !d.startsWith('/usr/')))].concat(SAFE_PATH).join(':');
}

let probed = null;
function detect(cfg) {
  cfg = cfg || {};
  const pref = cfg.engine || 'docker';
  if (probed && probed.pref === pref) return probed.res;
  const tries = pref === 'bwrap' ? ['bwrap', 'docker'] : ['docker', 'bwrap'];
  const why = [];
  let res = null;
  for (const e of tries) {
    if (e === 'docker') {
      if (!which('docker')) { why.push('docker is not installed'); continue; }
      const img = cfg.image || 'capheos-model-bench:1';
      const r = spawnSync('docker', ['image', 'inspect', img], { stdio: 'ignore', timeout: 15000 });
      if (r.status === 0) { res = { engine: 'docker', image: img }; break; }
      why.push('the bench image ' + img + ' is not built (packs/model-bench/sandbox/Dockerfile)');
    } else {
      if (!which('bwrap')) { why.push('bwrap is not installed'); continue; }
      const r = spawnSync('bwrap', ['--unshare-all', '--die-with-parent', '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib',
        '--symlink', 'usr/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev', '/usr/bin/true'], { stdio: 'ignore', timeout: 15000 });
      if (r.status === 0) { res = { engine: 'bwrap' }; break; }
      why.push('bwrap cannot make a namespace on this host');
    }
  }
  if (!res) res = { engine: null, why: why.join('; ') };
  probed = { pref, res };
  return res;
}

function makeInstance(root, runId, taskId) {
  const dir = path.join(baseDir(root), runId, taskId.replace(/[^A-Za-z0-9_.-]/g, '_'));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'work'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(baseDir(root), runId, '.pid'), String(process.pid));
  return { dir, work: path.join(dir, 'work'), tmp: path.join(dir, 'tmp') };
}
function removeInstance(inst) { try { fs.rmSync(inst.dir, { recursive: true, force: true }); } catch (_) {} }
function removeRun(root, runId) { try { fs.rmSync(path.join(baseDir(root), runId), { recursive: true, force: true }); } catch (_) {} }
// a crashed run's leftovers: every run folder whose process is gone
function sweep(root) {
  const b = baseDir(root); let n = 0;
  let ents = []; try { ents = fs.readdirSync(b); } catch (_) { return 0; }
  for (const e of ents) {
    let pid = 0; try { pid = Number(fs.readFileSync(path.join(b, e, '.pid'), 'utf8')); } catch (_) {}
    let alive = false; if (pid > 0) { try { process.kill(pid, 0); alive = pid !== process.pid || false; } catch (_) {} }
    if (pid === process.pid) continue;
    if (!alive) { fs.rmSync(path.join(b, e), { recursive: true, force: true }); n++; }
  }
  return n;
}

function writeFiles(work, files) {
  for (const [rel, body] of Object.entries(files || {})) {
    if (rel.startsWith('/') || rel.split('/').includes('..')) throw new Error('fixture path escapes the workspace: ' + rel);
    const p = path.join(work, rel); fs.mkdirSync(path.dirname(p), { recursive: true });
    if (body && typeof body === 'object' && body.mode) { fs.writeFileSync(p, body.text); fs.chmodSync(p, body.mode); } else fs.writeFileSync(p, body);
  }
}
// path -> sha1 of every file (the .git folder is listed by its refs only)
function tree(work) {
  const crypto = require('crypto'); const out = {};
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name), rel = path.relative(work, p);
    if (e.isDirectory()) { if (e.name === '.git' || e.name === 'node_modules' || e.name === '.dart_tool' || e.name === '__pycache__') continue; walk(p); }
    else if (e.isFile()) out[rel] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); } };
  walk(work); return out;
}

/* run one shell command in the instance. o: { engine, image, timeoutSec (60), maxOut (64 KB), env } -> {code, out, timedOut} */
function exec(inst, cmd, o) {
  o = o || {};
  const timeoutMs = Math.max(1, Number(o.timeoutSec) || 60) * 1000, maxOut = Number(o.maxOut) || 65536;
  const env = Object.assign({ HOME: '/work', PATH: toolPath(), TMPDIR: '/tmp' }, BENCH_GIT_ENV, o.env || {});
  let bin, args, cwd = inst.work, name = null, spawnEnv;
  if (o.engine === 'docker') {
    name = 'model-bench-' + process.pid + '-' + Math.random().toString(16).slice(2, 10);
    const uid = typeof process.getuid === 'function' ? process.getuid() + ':' + process.getgid() : '1000:1000';
    bin = 'docker'; args = ['run', '--rm', '--name', name, '--network', 'none', '--read-only', '--tmpfs', '/tmp:size=256m', '--memory', o.memory || '1g',
      '--cpus', String(o.cpus || 1), '--pids-limit', '256', '--user', uid, '-v', inst.work + ':/work', '-w', '/work'];
    for (const [k, v] of Object.entries(env)) if (k !== 'PATH') args.push('-e', k + '=' + v);
    args.push(o.image || 'capheos-model-bench:1', 'bash', '-c', cmd);
    spawnEnv = { PATH: process.env.PATH || SAFE_PATH };
  } else if (o.engine === 'bwrap') {
    bin = 'bwrap'; args = ['--unshare-all', '--die-with-parent', '--new-session', '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib',
      '--symlink', 'usr/lib64', '/lib64', '--symlink', 'usr/bin', '/sbin', '--ro-bind-try', '/etc/ssl', '/etc/ssl', '--ro-bind-try', '/etc/ca-certificates', '/etc/ca-certificates',
      '--ro-bind-try', '/etc/passwd', '/etc/passwd', '--ro-bind-try', '/etc/group', '/etc/group', '--ro-bind-try', '/etc/hosts', '/etc/hosts',
      '--proc', '/proc', '--dev', '/dev', '--bind', inst.work, '/work', '--bind', inst.tmp, '/tmp', '--chdir', '/work', '--clearenv'];
    for (const d of toolDirs()) args.push('--ro-bind', d, d);
    for (const [k, v] of Object.entries(env)) args.push('--setenv', k, String(v));
    args.push('/usr/bin/bash', '-c', cmd);
    spawnEnv = {};
  } else if (o.engine === 'trusted') {
    // our own oracle actions and check scripts only (conformance): the workspace path stands in for /work
    bin = '/usr/bin/bash'; args = ['-c', cmd];
    spawnEnv = Object.assign({}, env, { HOME: inst.work, TMPDIR: inst.tmp, BENCH_WORK: inst.work });
  } else return Promise.resolve({ code: 126, out: 'refused: no sandbox engine', timedOut: false, refused: true });
  return new Promise(resolve => {
    let out = '', size = 0, timedOut = false, done = false;
    const child = spawn(bin, args, { cwd, env: spawnEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const take = c => { size += c.length; if (out.length < maxOut) out += c.toString('utf8').slice(0, maxOut - out.length); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    const killTree = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {} if (name) spawnSync('docker', ['kill', name], { stdio: 'ignore', timeout: 15000 }); };
    const t = setTimeout(() => { timedOut = true; killTree(); }, timeoutMs);
    const finish = code => { if (done) return; done = true; clearTimeout(t); killTree(); resolve({ code: timedOut ? 124 : code, out: out + (size > maxOut ? '\n[output cut at ' + maxOut + ' bytes]' : ''), timedOut }); };
    child.on('error', e => { out += String(e.message); finish(127); });
    child.on('close', code => finish(code == null ? 128 : code));
  });
}
module.exports = { dartBin, detect, makeInstance, removeInstance, removeRun, sweep, writeFiles, tree, exec, baseDir, SAFE_PATH, BENCH_GIT_ENV, _reset: () => { probed = null; } };
