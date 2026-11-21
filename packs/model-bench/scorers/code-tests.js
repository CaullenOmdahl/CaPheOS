'use strict';
/* Kinds 6 and 7, code. After the model is done: (d) the diff stays inside the allowed paths and no locked file changed
 * (kind 6: only the named file); then the hidden tests are added and (a) they pass, (b) the repo's own suite still passes,
 * (c) the lint command is clean. Everything runs in the instance's sandbox. All must hold. */
const C = require('../lib/checks');
async function score(ans, exp, ctx) {
  if (!ctx || !ctx.work || !ctx.exec) return { pass: false, score: 0, detail: 'no workspace to score' };
  const sc = C.scope(ctx, exp);
  if (!sc.changed.length) return { pass: false, score: 0, detail: 'nothing was changed' };
  const bad = sc.problems.slice();
  // the lint and the task's own checks see the model's work alone; then the hidden tests are added and run, then the suite
  for (const f of await C.run(ctx, (exp.lintCmds || []).map(c => ({ name: 'lint: ' + c, cmd: c })))) bad.push(f);
  for (const f of await C.run(ctx, exp.checks)) bad.push(f);
  C.place(ctx, exp.hidden);
  for (const [label, cmds] of [['hidden tests', exp.testCmds], ['existing suite', exp.suiteCmds]]) for (const f of await C.run(ctx, (cmds || []).map(c => ({ name: label + ': ' + c, cmd: c })))) bad.push(f);
  return { pass: !bad.length, score: bad.length ? 0 : 1, detail: bad.slice(0, 6).join('; ') || 'hidden tests, suite and lint pass; ' + sc.changed.length + ' file(s) changed in scope' };
}
module.exports = { score };
