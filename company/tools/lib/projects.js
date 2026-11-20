/* lib/projects.js — the product-takeover registry (company/projects.json) as data, for project.js and the seats' dossiers.
 *
 * relationship: client | own. A product the company did not found is client work, the owner's own product included: its
 * current behaviour, equipment, staff routine and release flow are the brief (house rules v16, company/DECISION_RIGHTS.md
 * "Client work"). Every row the registry holds came in through a takeover, so a row without the field, or with any other
 * value, is client. Only the owner marks a product `own` (one the company founded), with project.js relationship.
 */
'use strict';
const fs = require('fs');
const co = require('./company');

const RELATIONSHIPS = ['client', 'own'];
const file = () => co.p('company', 'projects.json');
function load() {
  try { const j = JSON.parse(fs.readFileSync(file(), 'utf8')); if (j && Array.isArray(j.projects)) return j; } catch (_) {}
  return { version: 1, projects: [] };
}
const relationshipOf = p => (p && p.relationship === 'own') ? 'own' : 'client';
const live = p => !!p && (p.state === 'approved' || p.state === 'active');
const NOTE = {
  client: 'client work: its current behaviour, equipment, staff routine and release flow are the brief; fix bugs, anything unrequested is a one-line suggestion and the current way continues',
  own: 'the company\'s own product',
};
// one line for a seat's context: the live projects and what each relationship means ('' when there are none)
function contextLine(db) {
  const rows = (db || load()).projects.filter(live);
  if (!rows.length) return '';
  return 'Projects the company works on (company/projects.json): ' + rows.map(p => (p.name || p.id) + ' (' + relationshipOf(p) + ': ' + NOTE[relationshipOf(p)] + ')').join('; ') + '.';
}

module.exports = { RELATIONSHIPS, file, load, relationshipOf, live, NOTE, contextLine };
