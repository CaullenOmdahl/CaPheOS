'use strict';
/* Kind 3, writing. Layer 1 (our code, every rule must hold): the word range, no banned jargon, no file paths or
 * secret-shaped strings, none of the internal details that must be left out, the required closing ask, and a reading-level
 * ceiling. Layer 2 (the judge, blind): each required point as a yes/no question; DRFR = yes / questions >= 0.9.
 * Without a judge (none set, or the judge is the model under test) the task is not proven, never failed. */
const T = require('../lib/text');
async function score(ans, exp, ctx) {
  const note = String((ans && ans.note) || '');
  const fails = [];
  const n = T.words(note).length;
  if (n < exp.minWords || n > exp.maxWords) fails.push('length ' + n + ' words, wanted ' + exp.minWords + '-' + exp.maxWords);
  if (exp.maxSentences && T.sentences(note).length > exp.maxSentences) fails.push(T.sentences(note).length + ' sentences, at most ' + exp.maxSentences);
  const j = T.jargonHits(note, exp.banned); if (j.length) fails.push('jargon: ' + j.join(', '));
  if (T.PATH_RE.test(note)) fails.push('a file path');
  if (T.SECRET_RE.test(note)) fails.push('a secret-shaped string');
  for (const f of exp.forbid || []) if (note.toLowerCase().includes(String(f).toLowerCase())) fails.push('an internal detail that must stay out: ' + f);
  if (exp.closingAsk) {
    const tail = T.sentences(note).slice(-2).join(' ');
    if (!/\?/.test(tail)) fails.push('no closing question to the owner');
    else if (exp.askWords && exp.askWords.length && !exp.askWords.some(w => tail.toLowerCase().includes(w.toLowerCase()))) fails.push('the closing question does not ask about ' + exp.askWords[0]);
  }
  const g = T.grade(note); if (exp.gradeMax && g > exp.gradeMax) fails.push('reading grade ' + g.toFixed(1) + ' over ' + exp.gradeMax);
  if (fails.length) return { pass: false, score: 0, detail: 'layer 1: ' + fails.join('; ') };
  if (!ctx || !ctx.judge) return { pass: false, score: null, notProven: 'judge-needed', detail: 'layer 1 passed; layer 2 needs the judge' };
  const out = await ctx.judge(exp.questions, note);
  if (!out || !Array.isArray(out.answers)) return { pass: false, score: 0, detail: 'the judge gave no usable answer', notProven: 'judge-error' };
  const yes = exp.questions.filter((q, i) => { const a = out.answers.find(x => Number(x.q) === i + 1); return a && a.yes === true; }).length;
  const drfr = yes / exp.questions.length;
  return { pass: drfr >= (exp.drfrMin || 0.9) - 1e-9, score: Math.round(drfr * 1000) / 1000, detail: 'layer 1 passed; DRFR ' + yes + '/' + exp.questions.length };
}
module.exports = { score };
