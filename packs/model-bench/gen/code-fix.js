'use strict';
/* Kind 6, simple code: one planted bug in one small function (fixtures/code6/cases.js), the hidden tests the scorer adds
 * afterwards, and only the named file may change. Shapes taken from HumanEvalFix (one planted bug from a bug-type list),
 * QuixBugs (one-line defects) and EvalPlus (strict extra hidden tests). Items are our own. The seed changes nothing in the
 * code (a static task with its own version); it only names the instance. */
const CASES = require('../fixtures/code6/cases');
const { CANARY_LINE } = require('../lib/world');
const LANG = {
  js: { hidden: 'test/bench-hidden.test.js', cmd: 'node test/bench-hidden.test.js', run: 'node <test file>', extra: {} },
  ts: { hidden: 'test/bench-hidden.test.ts', cmd: 'node --experimental-strip-types --no-warnings test/bench-hidden.test.ts', run: 'node --experimental-strip-types <test file>', extra: { 'package.json': '{ "type": "module" }\n' } },
  py: { hidden: 'tests/test_bench_hidden.py', cmd: 'python3 -I tests/test_bench_hidden.py', run: 'python3 -I <test file>', extra: { 'pkg/__init__.py': '' } },
  dart: { hidden: 'test/bench_hidden_test.dart', cmd: 'dart run test/bench_hidden_test.dart', run: 'dart run <test file>', extra: {} },
};
function buggy(c) {
  let s = c.fixed;
  for (const b of [c.bug, c.bug2].filter(Boolean)) { if (!s.includes(b[0])) throw new Error(c.id + ': the bug text is not in the fixed file'); s = s.replace(b[0], b[1]); }
  return s;
}
function byId(id) { const c = CASES.find(x => x.id === id); if (!c) throw new Error('no code6 case ' + id); return c; }
function generate(r, p) {
  const c = byId(p.case), L = LANG[c.lang];
  const files = Object.assign({}, L.extra, { [c.file]: buggy(c), 'README.md': '# ' + c.id + '\n\nRun a test file with `' + L.run + '`.\n\n<!-- ' + CANARY_LINE + ' -->\n' }, c.visible || {});
  const prompt = 'File to fix: ' + c.file + '\n\n' + c.desc + (c.visible ? '' : '\nThere are no tests in the workspace; write your own checks if you want, but only ' + c.file + ' may change in the end.');
  const expected = { hidden: { [L.hidden]: c.hidden }, testCmds: [L.cmd], allowed: [c.file], ignore: ['**/__pycache__/**', '.dart_tool/**', '**/*.pyc', 'scratch/**', '.dartServer/**', '.pub-cache/**', '.dart/**', '.config/**', '.cache/**', '.local/**'] };
  return { prompt, files, expected, oracle: { actions: [{ tool: 'write', path: c.file, content: c.fixed }], answer: { done: true, summary: 'fixed' } },
    // known-bad: a change to the visible test instead of the code, or a comment-only change
    bad: { actions: [{ tool: 'write', path: c.file, content: buggy(c) + (c.lang === 'py' ? '# checked\n' : '// checked\n') }], answer: { done: true, summary: 'looked fine' } } };
}
module.exports = { generate, CASES, LANG, buggy };
