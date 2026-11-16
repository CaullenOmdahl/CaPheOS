'use strict';
/* continuity lib — wind-down and handover (docs/CORE-MODULES.md, layer Guarantee). Used by company/tools/halt.js (soft
 * halt), the console (http.js) and the continuity.js tool.
 *
 * Reads commitments in the shared shape (company/work/commitments/<id>.json, written only by the commitments module's
 * commitments.js) — never writes them. Reassigning goes through `commitments.js reassign` (the commitments module owns
 * the state machine); notifying a party goes through external-gate.js category `message`.
 *
 *   open()          open commitments, sorted by due time, with byParty groups
 *   unowned()       the breach-able ones nobody holds: open (not closed/suppressed/cancelled/verified), with a due or ack
 *                   time, and an owner that is empty or not a seat in loops.json. A soft halt does not settle while any exist.
 *   reassign(id, to, by)   delegates to commitments.js; refused when the commitments module is not enabled
 *   notify(party, text, by)   gated: external-gate check {category:'message', target:'party:<id>'}; an allowed notice is
 *                   queued in company/work/continuity/notices.jsonl for the party's channel (reports/intake deliver it)
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const co = require('../../company/tools/lib/company');

const DIR = () => co.p('company', 'work', 'commitments');
const NOTICES = () => co.p('company', 'work', 'continuity', 'notices.jsonl');
const CLOSED = ['closed', 'suppressed', 'cancelled', 'verified'];
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const enabledMods = () => ((readJson(co.p('company', 'state', 'modules.json'), {}) || {}).enabled) || {};

function all() {
  let files = []; try { files = fs.readdirSync(DIR()).filter(f => f.endsWith('.json')); } catch (_) { return []; }
  const out = [];
  for (const f of files) { const c = readJson(path.join(DIR(), f), null); if (c && typeof c === 'object' && c.id && c.state) out.push(c); }
  return out;
}
const dueKey = c => Date.parse(c.dueAt || c.ackBy || '') || Infinity;
function ownerOk(c) { const o = String(c.owner || '').trim(); if (!o) return false; const crew = co.crew(); return !!crew[o] || Object.values(crew).some(s => s && s.name === o); }
function view(c) { return { id: c.id, title: c.title || c.key || c.id, party: c.party || null, state: c.state, owner: c.owner || null, ownerOk: ownerOk(c), dueAt: c.dueAt || null, ackBy: c.ackBy || null }; }
function open() {
  const list = all().filter(c => !CLOSED.includes(c.state)).sort((a, b) => dueKey(a) - dueKey(b)).map(view);
  const byParty = {};
  for (const c of list) (byParty[c.party || '(no party)'] = byParty[c.party || '(no party)'] || []).push(c);
  return { ok: true, commitmentsEnabled: !!enabledMods().commitments, count: list.length, commitments: list, byParty };
}
function unowned() { return open().commitments.filter(c => (c.dueAt || c.ackBy) && !c.ownerOk); }

function commitmentsTool() { const f = co.p('company', 'tools', 'commitments.js'); return fs.existsSync(f) ? f : null; }
function reassign(id, to, by) {
  if (!enabledMods().commitments) return { ok: false, error: 'the commitments module is not enabled' };
  const tool = commitmentsTool();
  if (!tool) return { ok: false, error: 'company/tools/commitments.js missing' };
  if (!/\breassign\b/.test(fs.readFileSync(tool, 'utf8'))) return { ok: false, error: 'commitments.js has no reassign command yet' };
  const r = spawnSync(process.execPath, [tool, 'reassign', String(id), '--to', String(to), '--by', String(by || 'owner'), '--json'], { cwd: co.ROOT, encoding: 'utf8', timeout: 30000 });
  let j = null; try { j = JSON.parse(r.stdout); } catch (_) {}
  return r.status === 0 ? Object.assign({ ok: true }, j || {}) : { ok: false, error: (j && j.error) || String(r.stderr || r.stdout).trim().slice(0, 300) || 'exit ' + r.status };
}
function notify(party, text, by) {
  if (!party || !text) return { ok: false, error: 'party and text are required' };
  let gate; try { gate = require(co.p('company', 'tools', 'external-gate.js')); } catch (e) { return { ok: false, error: 'external-gate.js missing (fail closed)' }; }
  let v; try { v = gate.check({ category: 'message', target: 'party:' + party, agent: by || 'owner' }); } catch (e) { v = { allow: false, reason: e.message }; }
  if (!v || !v.allow) return { ok: false, gated: true, error: 'external gate refused: ' + ((v && v.reason) || 'no verdict') + ' — clear it first: node company/tools/external-gate.js clear --by <owner> --category message --target party:' + party + ' ...' };
  const row = { at: new Date().toISOString(), party, text: String(text).slice(0, 4000), by: by || 'owner', clearanceId: v.clearanceId || null, status: 'queued' };
  fs.mkdirSync(path.dirname(NOTICES()), { recursive: true });
  fs.appendFileSync(NOTICES(), JSON.stringify(row) + '\n');
  return { ok: true, queued: row };
}
module.exports = { all, open, unowned, reassign, notify, CLOSED };
