'use strict';
// Plain-text measures for the writing checks: words, sentences, a Flesch-Kincaid grade, jargon, paths and secrets.
const words = s => (String(s).match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) || []);
const sentences = s => String(s).split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/).map(x => x.trim()).filter(Boolean);
function syllables(w) {
  w = w.toLowerCase().replace(/[^a-z]/g, ''); if (!w) return 0; if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|[^laeiouy]ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const m = w.match(/[aeiouy]{1,2}/g); return Math.max(1, m ? m.length : 1);
}
function grade(s) {
  const w = words(s), n = Math.max(1, sentences(s).length); if (!w.length) return 0;
  const syl = w.reduce((a, x) => a + syllables(x), 0);
  return 0.39 * (w.length / n) + 11.8 * (syl / w.length) - 15.59;
}
// words a non-technical owner should not have to read. Words with a plain everyday meaning too (token, pipeline, branch,
// commit, merge, container) count only in their technical phrases.
const JARGON = ['api', 'endpoint', 'refactor', 'deploy', 'deployment', 'repo', 'repository', 'git branch', 'feature branch', 'main branch',
  'git commit', 'merge request', 'merge conflict', 'pull request', 'stack trace', 'regression', 'null', 'runtime', 'backend', 'frontend', 'cron',
  'yaml', 'json', 'docker', 'docker container', 'latency', 'kubernetes', 'ci', 'ci pipeline', 'build pipeline', 'schema', 'config', 'localhost',
  'webhook', 'api token', 'access token', 'auth token', 'sandbox', 'hotfix', 'rollback', 'stdout'];
function jargonHits(s, extra) {
  const t = ' ' + String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ') + ' ';
  return JARGON.concat(extra || []).filter(j => t.includes(' ' + j.toLowerCase() + ' '));
}
const PATH_RE = /(?:^|[\s(`'"])(?:~?\/|\.\.?\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,5}\b|(?:^|\s)\/(?:home|etc|var|usr|tmp)\/\S+/;
const SECRET_RE = /\b(?:sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{12,}\b|\b[A-Fa-f0-9]{32,}\b|-----BEGIN [A-Z ]*KEY-----|\bAKIA[0-9A-Z]{16}\b/;
module.exports = { words, sentences, syllables, grade, JARGON, jargonHits, PATH_RE, SECRET_RE };
