'use strict';
/* Kind 7, bigger code: a feature across several files of one of the fixture repos (fixtures/repos/<repo>), asked for the
 * way a handoff asks. Scored by (a) the hidden feature tests, (b) the repo's own suite, (c) its lint, (d) a diff inside
 * the allowed paths with no locked file changed. Shapes taken from SWE-bench (tests that must start passing and tests
 * that must keep passing), Multi-SWE-bench (non-Python repos) and Aider polyglot (the model may run the tests and retry).
 * Items are our own; the tasks are in fixtures/k7/<repo>.js. */
const fs = require('fs');
const path = require('path');
const { CANARY_LINE } = require('../lib/world');
const REPOS = {
  'node-svc': { test: f => 'node ' + f, suite: 'node test/run.js', lint: 'node scripts/lint.js', hiddenExt: '.test.js' },
  'ts-web': { test: f => 'node --experimental-strip-types --no-warnings ' + f, suite: 'node test/run.mjs', lint: 'node scripts/lint.mjs', hiddenExt: '.test.ts' },
  'py-pkg': { test: f => 'python3 -I ' + f, suite: 'python3 -I tests/run.py', lint: 'python3 -I scripts/lint.py', hiddenExt: '.py' },
  'dart-pkg': { test: f => 'dart run ' + f, suite: 'dart run test/all.dart', lint: 'dart analyze --fatal-infos lib test', hiddenExt: '_test.dart', setup: 'dart pub get --offline >/dev/null' },
};
const TASKS = [].concat(...['node-svc', 'ts-web', 'py-pkg', 'dart-pkg'].map(r => { try { return require('../fixtures/k7/' + r); } catch (e) { if (e.code === 'MODULE_NOT_FOUND') return []; throw e; } }));

function readTree(dir) {
  const out = {};
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!['.dart_tool', '__pycache__', 'node_modules'].includes(e.name)) walk(p); } else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8'); } };
  walk(dir); return out;
}
function applyEdits(base, edits, id) {
  const out = {};
  for (const [file, list] of Object.entries(edits || {})) {
    let s = out[file] !== undefined ? out[file] : base[file];
    if (s === undefined) throw new Error(id + ': edits a file that is not in the repo: ' + file);
    for (const [a, b] of list) { if (!s.includes(a)) throw new Error(id + ': edit text not found in ' + file + ': ' + a.slice(0, 60)); s = s.replace(a, b); }
    out[file] = s;
  }
  return out;
}
function byId(id) { const t = TASKS.find(x => x.id === id); if (!t) throw new Error('no k7 task ' + id); return t; }
function solution(t, base) { return Object.assign({}, applyEdits(base, t.edits, t.id), t.add || {}); }
function generate(r, p, ctx) {
  const t = byId(p.case), R = REPOS[t.repo];
  const base = readTree(path.join(ctx.unitDir, 'fixtures', 'repos', t.repo));
  const sol = solution(t, base);
  const hiddenFile = Object.keys(t.hidden)[0];
  const handoff = ['# Handoff: ' + t.id.replace(/-/g, ' '), '', '**From:** the client lead **To:** you', '**Repo:** this workspace (' + t.repo + ')', '',
    t.request, '', 'Locked (must not change): ' + ((t.locked || []).join(', ') || 'nothing'), 'Tests: `' + R.suite + '`. Lint: `' + R.lint + '`.', '', '<!-- ' + CANARY_LINE + ' -->', ''].join('\n');
  const expected = { hidden: t.hidden, testCmds: [R.test(hiddenFile)], suiteCmds: [R.suite], lintCmds: [R.lint], checks: t.checks || [],
    allowed: t.allowed, locked: t.locked || [], ignore: ['**/__pycache__/**', '.dart_tool/**', '**/*.pyc', 'pubspec.lock', 'scratch/**', '.dartServer/**', '.dart-tool/**', '.pub-cache/**', '.dart/**', '.config/**', '.cache/**', '.local/**'] };
  const writes = o => Object.entries(o).map(([k, v]) => ({ tool: 'write', path: k, content: v }));
  let bad;
  if (t.bad === 'locked') bad = writes(Object.assign({}, sol, applyEdits(Object.assign({}, base, sol), t.badEdit, t.id)));
  else { const first = Object.keys(t.edits)[0]; bad = writes({ [first]: sol[first] }); }
  return { prompt: handoff, files: base, setupCmd: R.setup, expected, oracle: { actions: writes(sol), answer: { done: true, summary: t.id } }, bad: { actions: bad, answer: { done: true, summary: t.id } } };
}
module.exports = { generate, TASKS, REPOS, readTree, applyEdits, solution };
