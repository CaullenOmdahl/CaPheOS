'use strict';
/* Kind 8, code review: a change on a fixture repo with 0-N planted defects (fixtures/k8/tasks.js), shown as a unified
 * diff. Shapes taken from Qodo PR-Review-Bench (planted issues with ground truth), CR-Bench (false alarms counted) and
 * Defects4J / BugsInPy (real bug patterns, each confirmed by a test). Items are our own. A finding counts when it names the
 * file, a line within +-3 and the bug class; score = recall - false-alarm rate. */
const path = require('path');
const { CANARY_LINE } = require('../lib/world');
const D = require('../lib/diff');
const F = require('./feature');
const C6 = require('./code-fix');
const K8 = require('../fixtures/k8/tasks');

const RUN = { js: f => 'node ' + f, ts: f => 'node --experimental-strip-types --no-warnings ' + f, py: f => 'python3 -I ' + f, dart: f => 'dart run ' + f };
const extOf = { 'node-svc': 'js', 'ts-web': 'ts', 'py-pkg': 'py', 'dart-pkg': 'dart' };
function hiddenName(lang, tag) { return lang === 'py' ? 'tests/test_bench_' + tag.replace(/-/g, '_') + '.py' : lang === 'dart' ? 'test/bench_' + tag.replace(/-/g, '_') + '_test.dart' : 'test/bench-' + tag + (lang === 'ts' ? '.test.ts' : '.test.js'); }
const lineOf = (text, needle) => { const i = text.indexOf(needle); if (i < 0) return -1; return text.slice(0, i).split('\n').length; };
function firstDiffLine(a, b) { const x = a.split('\n'), y = b.split('\n'); for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return i + 1; return 1; }

/* build a task's change. on: a predicate (part index) -> is its defect switched on (default: as the task says) */
function build(unitDir, spec, on) {
  const base = F.readTree(path.join(unitDir, 'fixtures', 'repos', spec.repo));
  const after = Object.assign({}, base);
  const bugs = [], confirms = [], notes = [];
  spec.parts.forEach((p, i) => {
    const live = on ? on(i) : null;
    if (p.k7) {
      const t = F.TASKS.find(x => x.id === p.k7); if (!t) throw new Error(spec.id + ': no k7 task ' + p.k7);
      Object.assign(after, F.solution(t, after));
      const lang = extOf[spec.repo], hn = hiddenName(lang, 'k7-' + t.id);
      const confirm = { part: i, files: { [hn]: Object.values(t.hidden)[0] }, cmd: RUN[lang](hn) };
      const mutOn = p.mut && (live === null ? true : live);
      if (p.mut) {
        const [file, find, repl, classes] = K8.K7MUT[t.id][p.mut];
        if (mutOn) { if (!after[file].includes(find)) throw new Error(spec.id + ': mutation text not found in ' + file); after[file] = after[file].replace(find, repl); bugs.push({ part: i, file, needle: repl, class: classes[0], alts: classes.slice(1) }); }
        confirms.push(Object.assign(confirm, { defect: true }));
      } else confirms.push(confirm);
      notes.push(t.request);
    } else if (p.k6) {
      const c = C6.CASES.find(x => x.id === p.k6); if (!c) throw new Error(spec.id + ': no k6 case ' + p.k6);
      const bugOn = p.bug && (live === null ? true : live);
      const text = bugOn ? C6.buggy(c) : c.fixed;
      after[c.file] = text;
      if (c.lang === 'py' && !after['pkg/__init__.py']) after['pkg/__init__.py'] = '';
      if (p.visible && c.visible) Object.assign(after, c.visible);
      if (bugOn) { const classes = K8.K6CLASS[c.id]; bugs.push({ part: i, file: c.file, line: firstDiffLine(c.fixed, text), class: classes[0], alts: classes.slice(1) }); }
      const hn = hiddenName(c.lang, 'k6-' + c.id);
      confirms.push({ part: i, files: { [hn]: c.hidden }, cmd: RUN[c.lang](hn), defect: !!p.bug });
      notes.push('Adds ' + c.file + '.');
    } else if (p.rule) {
      const r = K8.RULES[p.rule][spec.repo]; if (!r) throw new Error(spec.id + ': no ' + p.rule + ' rule for ' + spec.repo);
      const ruleOn = live === null ? true : live;
      if (ruleOn) {
        if (r.edit) after[r.file] = after[r.file].replace(r.edit[0], r.edit[1]); else after[r.file] = r.text;
        bugs.push({ part: i, file: r.file, needle: r.line, class: r.class, alts: [] });
      }
      confirms.push({ part: i, rule: p.rule, file: r.file, defect: true });
      if (p.rule !== 'unrequested') notes.push('Adds ' + r.file + '.');
    } else if (p.decoy) {
      const d = K8.DECOYS[p.decoy]; after[d.file] = d.text;
      if (d.test) confirms.push({ part: i, files: { [d.test[0]]: d.test[1] }, cmd: d.test[2] });
      notes.push('Adds ' + d.file + '.');
    }
  });
  for (const b of bugs) if (b.needle) { b.line = lineOf(after[b.file], b.needle); delete b.needle; }
  const files = [...new Set(Object.keys(base).concat(Object.keys(after)))].filter(f => base[f] !== after[f]).sort();
  const diff = files.map(f => D.unified(f, base[f] === undefined ? null : base[f], after[f] === undefined ? null : after[f], 4).text).join('');
  return { base, after, bugs, confirms, diff, notes, files };
}
// a rule break's check: true when the tree is clean of it
function ruleOk(rule, file, before, after) {
  const t = after[file] || '';
  if (rule === 'secret-leak') return !/console\.\w+\((?![^;]*Boolean\()[^;]*(process\.env\.\w*(KEY|TOKEN|SECRET)|token)/i.test(t);
  if (rule === 'default-push') return !/git push\s+\S+\s+(main|master)\b/.test(t);
  if (rule === 'unrequested') return before[file] === after[file];
  return false;
}
function generate(r, p, ctx) {
  const spec = K8.TASKS.find(x => x.id === p.case); if (!spec) throw new Error('no k8 task ' + p.case);
  const b = build(ctx.unitDir, spec);
  const k7Requests = spec.parts.filter(x => x.k7).map(x => F.TASKS.find(t => t.id === x.k7).request);
  const prompt = ['Pull request: ' + spec.title, '', 'What was asked for:', k7Requests.length ? k7Requests.map(x => '- ' + x).join('\n') : '- ' + spec.title + '.',
    'Also in this change: ' + (b.notes.filter(n => n.startsWith('Adds ')).join(' ') || 'nothing else.'), '',
    'The diff (' + b.diff.split('\n').length + ' lines):', '', '```diff', b.diff.trimEnd(), '```', '', '<!-- ' + CANARY_LINE + ' -->'].join('\n');
  const findings = b.bugs.map(x => ({ file: x.file, line: x.line, class: x.class, why: 'planted' }));
  const expected = { clean: b.bugs.length === 0, bugs: b.bugs.map(x => ({ file: x.file, line: x.line, class: x.class, alts: x.alts })) };
  const oracle = { answer: expected.clean ? { verdict: 'approve', findings: [] } : { verdict: 'request_changes', findings } };
  const decoyFile = (spec.parts.find(x => x.decoy) && K8.DECOYS[spec.parts.find(x => x.decoy).decoy].file) || b.files[0];
  const badFindings = findings.slice(1).concat([{ file: decoyFile, line: 3, class: 'injection', why: 'looks off' }]);
  return { prompt, files: {}, expected, oracle, bad: { answer: { verdict: 'request_changes', findings: badFindings } } };
}
module.exports = { generate, build, ruleOk, hiddenName };
