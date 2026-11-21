'use strict';
// The task file format (spec section 3), checked by hand so the unit needs no dependency.
const KINDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const DEPTHS = ['lookup', 'simple', 'standard', 'deep'];
const SANDBOX = ['none', 'files', 'exec'];
const TOOLS = ['read', 'list', 'write', 'shell'];
const { CANARY } = require('./world');
const REL = /^(?!\/)(?!.*\.\.)[A-Za-z0-9_./-]{1,200}$/;

function validate(t, fileName) {
  const f = [];
  const need = (c, m) => { if (!c) f.push(m); };
  if (!t || typeof t !== 'object') return ['not an object'];
  const ID = /^k(\d{1,2})-(lookup|simple|standard|deep)-\d{2}$/;
  need(typeof t.id === 'string' && ID.test(t.id), 'id must look like k5-standard-03');
  if (fileName) need(fileName === t.id + '.json', 'the file name must be the id (' + t.id + '.json)');
  need(KINDS.includes(t.kind), 'kind must be 1..10');
  need(DEPTHS.includes(t.depth), 'depth must be one of ' + DEPTHS.join(', '));
  const m = ID.exec(String(t.id)); if (m) { need(Number(m[1]) === t.kind, 'the id names kind ' + m[1]); need(m[2] === t.depth, 'the id names depth ' + m[2]); }
  need(Number.isInteger(t.version) && t.version >= 1, 'version must be an integer >= 1');
  need(t.canary === CANARY, 'canary must be the bench GUID');
  need(typeof t.title === 'string' && t.title.length >= 5 && t.title.length <= 140, 'title: 5 to 140 characters');
  if (t.generator != null) need(typeof t.generator === 'string' && REL.test(t.generator) && /^gen\/[a-z0-9-]+\.js$/.test(t.generator), 'generator must be gen/<name>.js');
  need(t.params && typeof t.params === 'object' && !Array.isArray(t.params), 'params must be an object');
  need(typeof t.prompt === 'string' && /^templates\/[a-z0-9-]+\.md$/.test(t.prompt), 'prompt must be templates/<name>.md');
  need(t.inputs && typeof t.inputs === 'object', 'inputs is required');
  if (t.inputs) {
    need(t.inputs.files === 'generated' || (typeof t.inputs.files === 'string' && REL.test(t.inputs.files) && t.inputs.files.startsWith('fixtures/')) || t.inputs.files === null, 'inputs.files: "generated", a fixtures/ path or null');
    need(Array.isArray(t.inputs.tools) && t.inputs.tools.every(x => TOOLS.includes(x)), 'inputs.tools: a list of ' + TOOLS.join(', '));
  }
  if (t.generator) need(t.expected === 'generated', 'a generated task has expected: "generated"');
  else { need(t.expected !== 'generated' && t.expected != null, 'a static task sets expected inline'); need(t.inputs && t.inputs.files !== 'generated', 'a static task names its fixtures'); }
  need(t.scorer && typeof t.scorer.name === 'string' && /^scorers\/[a-z0-9-]+\.js$/.test(t.scorer.name), 'scorer.name must be scorers/<name>.js');
  need(t.scorer && (t.scorer.args === undefined || (t.scorer.args && typeof t.scorer.args === 'object')), 'scorer.args must be an object');
  need(t.answerFormat === 'json', 'answerFormat must be json');
  need(Number.isInteger(t.timeLimitSec) && t.timeLimitSec >= 10 && t.timeLimitSec <= 3600, 'timeLimitSec: 10 to 3600');
  need(SANDBOX.includes(t.sandbox), 'sandbox must be one of ' + SANDBOX.join(', '));
  if (t.sandbox === 'exec') need(t.inputs && t.inputs.tools.includes('shell'), 'an exec task offers the shell tool');
  if (t.sandbox !== 'exec') need(!(t.inputs && t.inputs.tools.includes('shell')), 'only an exec task offers the shell tool');
  if (t.sandbox === 'none') need(t.inputs && t.inputs.tools.length === 0, 'a sandbox none task has no tools (its files are inline)');
  need(Number.isInteger(t.repeatK) && t.repeatK >= 1 && t.repeatK <= 5, 'repeatK: 1 to 5');
  need(t.source && Array.isArray(t.source.ideasFrom) && t.source.ideasFrom.length > 0 && t.source.items === 'own', 'source: ideasFrom (non-empty) and items "own"');
  const known = ['id', 'kind', 'depth', 'version', 'canary', 'title', 'generator', 'params', 'prompt', 'inputs', 'expected', 'scorer', 'answerFormat', 'timeLimitSec', 'sandbox', 'repeatK', 'source', 'maxTurns', 'notes'];
  for (const k of Object.keys(t)) need(known.includes(k), 'unknown field ' + k);
  if (t.maxTurns !== undefined) need(Number.isInteger(t.maxTurns) && t.maxTurns >= 1 && t.maxTurns <= 80, 'maxTurns: 1 to 80');
  return f;
}
module.exports = { validate, KINDS, DEPTHS, SANDBOX, TOOLS };
