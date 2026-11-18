'use strict';
/* lib/taskclass.js — the task class of a handoff item, and the department a seat sits in (docs/RANKING.md).
 *
 * The house ranking (company/tools/model-rank.js) scores models per task class, so a class has to be something every
 * tool reads the same way. Classes: code, review, research, writing, design, ops, mechanical, general.
 *
 *   const TC = require('./lib/taskclass');
 *   TC.CLASSES                          the class names, in that order
 *   TC.classOf(item, seat, { departments })
 *                                       the class of a handoff item (its text, or { text } / { class, effort }):
 *                                       an explicit `**Class:** <class>` line wins; else `**Effort:** mechanical` ->
 *                                       "mechanical"; else the seat's department defaultClass; else "general"
 *   TC.classLine(text)                  the class a `**Class:**` line names, or null (an unknown word is null)
 *   TC.departments({ root, file })      company/departments.json (defaults: company/defaults/departments.json is copied
 *                                       at founding; a missing file = no departments, and everything behaves as before)
 *   TC.deptOf(seat, deps)               the department a seat leads or is a member of, or null
 *   TC.leadOf(seat, deps, crew)         who grades a seat's work as its lead: the department lead (not the seat itself),
 *                                       else the seat's manager in loops.json, else null
 * Pure apart from departments() (one small file read). Owner: the tools function.
 * When company/tools/lib/company.js gains deptOf()/leadOf() these delegate to it; until then they read the same file.
 */
const fs = require('fs');
const path = require('path');

const CLASSES = ['code', 'review', 'research', 'writing', 'design', 'ops', 'mechanical', 'general'];
const ALIASES = { coding: 'code', engineering: 'code', reviewing: 'review', qa: 'review', docs: 'writing', doc: 'writing', operations: 'ops', infra: 'ops' };

const field = (text, name) => { const m = String(text || '').match(new RegExp('^\\*\\*' + name + ':\\*\\*(.*)$', 'mi')); return m ? m[1].trim() : null; };
function norm(word) {
  const w = String(word || '').replace(/[`*_]/g, '').trim().toLowerCase().split(/[\s,;(—-]/)[0];
  if (!w) return null;
  if (CLASSES.includes(w)) return w;
  return ALIASES[w] || null;
}
function classLine(text) { const v = field(text, 'Class'); return v == null ? null : norm(v); }

function departments(o) {
  o = o || {};
  let file = o.file;
  if (!file) { const root = o.root || require('./company').ROOT; file = path.join(root, 'company', 'departments.json'); }
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && Array.isArray(j.departments) ? j : { departments: [] }; } catch (_) { return { departments: [] }; }
}
const listOf = deps => (deps && Array.isArray(deps.departments) ? deps.departments : Array.isArray(deps) ? deps : []);
function deptOf(seat, deps) {
  if (!seat) return null;
  try { const co = require('./company'); if (typeof co.deptOf === 'function' && deps == null) return co.deptOf(seat); } catch (_) {}
  const list = listOf(deps);
  return list.find(d => d && d.lead === seat) || list.find(d => d && Array.isArray(d.members) && d.members.includes(seat)) || null;
}
function leadOf(seat, deps, crew) {
  const d = deptOf(seat, deps);
  if (d && d.lead && d.lead !== seat) return d.lead;
  const c = crew || {};
  const s = c[seat];
  return s && s.manager ? s.manager : null;
}

function classOf(item, seat, o) {
  o = o || {};
  const text = typeof item === 'string' ? item : (item && item.text) || '';
  const explicit = item && typeof item === 'object' && item.class ? norm(item.class) : classLine(text);
  if (explicit) return explicit;
  const effort = item && typeof item === 'object' && item.effort ? String(item.effort) : field(text, 'Effort');
  if (/^\s*mechanical\b/i.test(String(effort || ''))) return 'mechanical';
  const d = deptOf(seat, o.departments);
  const dc = d && norm(d.defaultClass);
  return dc || 'general';
}

module.exports = { CLASSES, classOf, classLine, departments, deptOf, leadOf };
