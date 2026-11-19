#!/usr/bin/env node
/* check-temp-hygiene.js — every test, walk and selftest cleans up its temp files and helper processes, however it ends.
 *
 *   node scripts/check-temp-hygiene.js [--json]
 *
 * A static scan of the framework's own code (tests/, company/tools/, console/, modules/, scripts/, packs/). It fails when
 * a file makes temp files or starts a browser without the shared helper:
 *   - JavaScript: mkdtemp, os.tmpdir() or a spawn with --user-data-dir, in a file that does not use
 *     company/tools/lib/temp-life.js (tmpDir / own / track / chrome);
 *   - Python: tempfile.mkdtemp / mkstemp / NamedTemporaryFile(delete=False) without tempfile.TemporaryDirectory(),
 *     addCleanup or atexit in the same file (the framework has no Python twin of temp-life: this is the rule instead);
 *   - shell: mktemp without a `trap … EXIT|RETURN` in the same file.
 * A runtime use that is not a test (a tool that writes beside its target and renames, a preview that removes its own
 * profile) is listed in scripts/temp-hygiene-allow.json with its reason. An entry without a reason, or one whose file
 * no longer makes temp files, fails the check too, so the list stays true.
 * Without this, a walk killed by its timeout left its Chrome and its profile (100-600 MB) in /tmp, which is RAM on most
 * Linux hosts (2026-11-19: 31 of 32 GB).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const ALLOW_FILE = path.join(REPO, 'scripts', 'temp-hygiene-allow.json');
const ROOTS = ['tests', 'company/tools', 'company/patches', 'console', 'modules', 'scripts', 'packs'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'fixtures-out', 'ui']);

function walk(dir, out) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, out); }
    else if (/\.(c?js|mjs|py|sh)$/.test(e.name)) out.push(p);
  }
  return out;
}
// comments out, so a header that explains the rule does not trip it
const stripJs = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
const stripHash = s => s.replace(/^\s*#.*$/gm, '');

function problems(rel, text) {
  if (/\.(c?js|mjs)$/.test(rel)) {
    const s = stripJs(text);
    const makes = /\bmkdtemp(Sync)?\s*\(|\btmpdir\s*\(\s*\)|--user-data-dir=/.test(s);
    if (!makes) return null;
    if (/temp-life/.test(s)) return null;
    return 'makes temp files or starts a browser without company/tools/lib/temp-life.js';
  }
  if (/\.py$/.test(rel)) {
    const s = stripHash(text);
    if (!/tempfile\.(mkdtemp|mkstemp)\s*\(|NamedTemporaryFile\([^)]*delete\s*=\s*False/.test(s)) return null;
    if (/TemporaryDirectory\s*\(|addCleanup\s*\(|atexit|temp_life/.test(s)) return null;
    return 'makes temp files without tempfile.TemporaryDirectory(), addCleanup or atexit';
  }
  if (/\.sh$/.test(rel)) {
    const s = stripHash(text);
    if (!/\bmktemp\b/.test(s)) return null;
    if (/\btrap\s+[^\n]*\b(EXIT|RETURN)\b/.test(s)) return null;
    return 'uses mktemp without a trap that removes it on EXIT';
  }
  return null;
}
// does the file make temp files at all (for stale allowlist entries)
function makesTemp(rel, text) {
  if (/\.(c?js|mjs)$/.test(rel)) return /\bmkdtemp(Sync)?\s*\(|\btmpdir\s*\(\s*\)|--user-data-dir=/.test(stripJs(text));
  if (/\.py$/.test(rel)) return /tempfile\./.test(text);
  if (/\.sh$/.test(rel)) return /\bmktemp\b/.test(text);
  return false;
}

function check(repo) {
  let allow = {};
  try { allow = JSON.parse(fs.readFileSync(path.join(repo, 'scripts', 'temp-hygiene-allow.json'), 'utf8')).files || {}; }
  catch (e) { return { ok: false, bad: [{ file: 'scripts/temp-hygiene-allow.json', why: 'unreadable: ' + e.message }], scanned: 0 }; }
  const bad = [];
  let scanned = 0;
  const files = [];
  for (const r of ROOTS) walk(path.join(repo, r), files);
  for (const f of files) {
    const rel = path.relative(repo, f).split(path.sep).join('/');
    if (rel === 'scripts/check-temp-hygiene.js') continue;   // its own selftest writes the bad patterns on purpose
    scanned++;
    const why = problems(rel, fs.readFileSync(f, 'utf8'));
    if (why && !allow[rel]) bad.push({ file: rel, why });
  }
  for (const [rel, reason] of Object.entries(allow)) {
    if (typeof reason !== 'string' || reason.trim().length < 10) bad.push({ file: rel, why: 'allowlist entry without a reason' });
    else if (!fs.existsSync(path.join(repo, rel))) bad.push({ file: rel, why: 'allowlist entry for a file that no longer exists' });
    else if (!makesTemp(rel, fs.readFileSync(path.join(repo, rel), 'utf8'))) bad.push({ file: rel, why: 'allowlist entry for a file that no longer makes temp files' });
  }
  return { ok: bad.length === 0, bad, scanned };
}

function selftest() {
  const os = require('os');
  const life = require(path.join(REPO, 'company', 'tools', 'lib', 'temp-life.js'));
  const T = life.tmpDir('temp-hygiene-selftest-');
  const w = (rel, text) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  w('scripts/temp-hygiene-allow.json', JSON.stringify({ files: { 'company/tools/runtime.js': 'writes beside its target and renames it into place' } }));
  w('tests/good-walk.js', "const life = require('../company/tools/lib/temp-life'); const d = life.tmpDir('x-');\n");
  w('company/tools/runtime.js', "const d = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'r-'));\n");
  w('tests/comment-only.js', "/* never fs.mkdtempSync( here */\n// os.tmpdir() in a comment\n");
  w('tests/ok.py', "import tempfile\nwith tempfile.TemporaryDirectory() as d:\n  pass\n");
  w('scripts/ok.sh', 'd=$(mktemp -d); trap \'rm -rf "$d"\' EXIT\n');
  let r = check(T);
  if (!r.ok) throw new Error('clean tree flagged: ' + JSON.stringify(r.bad));
  w('tests/bad-walk.js', "const d = fs.mkdtempSync(path.join(os.tmpdir(), 'leak-'));\n");
  w('tests/bad-chrome.js', "spawn(bin, ['--headless=new', '--user-data-dir=' + d]);\n");
  w('modules/m/tests/bad.py', "import tempfile\nd = tempfile.mkdtemp()\n");
  w('scripts/bad.sh', 'd=$(mktemp -d)\n');
  r = check(T);
  const flagged = r.bad.map(b => b.file).sort();
  const want = ['modules/m/tests/bad.py', 'scripts/bad.sh', 'tests/bad-chrome.js', 'tests/bad-walk.js'];
  if (JSON.stringify(flagged) !== JSON.stringify(want)) throw new Error('flagged ' + JSON.stringify(flagged) + ', want ' + JSON.stringify(want));
  for (const f of want) fs.rmSync(path.join(T, f));
  w('scripts/temp-hygiene-allow.json', JSON.stringify({ files: { 'company/tools/runtime.js': '', 'tests/good-walk.js': 'stale entry for a file that is fine', 'tests/gone.js': 'a file that is not there any more' } }));
  fs.writeFileSync(path.join(T, 'tests/good-walk.js'), 'module.exports = 1;\n');
  r = check(T);
  const why = Object.fromEntries(r.bad.map(b => [b.file, b.why]));
  if (!/without a reason/.test(why['company/tools/runtime.js'] || '') || !/no longer makes/.test(why['tests/good-walk.js'] || '') || !/no longer exists/.test(why['tests/gone.js'] || '')) throw new Error('allowlist rules: ' + JSON.stringify(why));
  void os;
  life.cleanup();
  console.log('check-temp-hygiene selftest: ok');
}

if (require.main === module) {
  if (process.argv.includes('--selftest') || process.argv[2] === 'selftest') { selftest(); process.exit(0); }
  const r = check(REPO);
  if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 1));
  else if (r.ok) console.log('temp hygiene: ok (' + r.scanned + ' files)');
  else { console.log('temp hygiene: ' + r.bad.length + ' problem(s)'); for (const b of r.bad) console.log('  ' + b.file + ': ' + b.why); console.log('Use company/tools/lib/temp-life.js, or list a runtime use in scripts/temp-hygiene-allow.json with its reason.'); }
  process.exit(r.ok ? 0 : 1);
}
module.exports = { check, problems };
