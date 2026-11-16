#!/usr/bin/env node
/* station-crew.js — change who works on the station, headlessly, the way the StarNet page itself would.
 *
 * Why this exists: StarNet keeps each agent in two places. The station SAVE (agent.save.json: name, skin, desk, docs
 * identity/purpose/manual/context, approval mode) is what the page rebuilds the crew from; the server ROSTER
 * (agent.roster.json: the composed system prompt) is what unattended routine runs read. The page normally composes
 * prompts and pushes the roster. With no page open, an edit has to change both, or it is lost or never used:
 *   1. GET /api/save, edit the doc, POST /api/save on the same revision (a conflict means re-read and redo);
 *   2. recompose the agent's system prompt with the app's own composer (starnet/bin/lib/app-modules.js) and push it
 *      with POST /api/agent/personality (reply via:"roster" means it took; via:"page" means a page is open: stop).
 * Never hand-edit agent.save.json or agent.roster.json while the station runs.
 *
 * Module:  const C = require('./station-crew.js');
 *          await C.editSave(doc => { ... })     // read-modify-write with conflict retry; returns the new revision
 *          await C.syncPrompt(agentId)           // recompose from the save and push to the roster
 * CLI:     node company/tools/station-crew.js list
 *          node company/tools/station-crew.js sync --agent <id> | --all
 * Owner of this tool: the tools function holder (loops.json functions: tools).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const co = require('./lib/company');
const ROOT = co.ROOT;
const W = co.p('.starnet-data', 'workspaces');
const STATION = new URL(co.STATION_URL);
const FORK = '\n\nMID-TASK PREFERENCE FORK';

function call(method, p, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let token; try { token = co.stationToken(); } catch (e) { reject(e); return; }   // read per call, so requiring this module never needs the secret
    const req = http.request({ hostname: STATION.hostname, port: STATION.port || 80, path: p, method, timeout: timeoutMs || 30000,
      headers: Object.assign({ 'x-starnet-token': token }, body ? { 'Content-Type': 'application/json' } : {}) }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
}
const j = r => { try { return JSON.parse(r.body); } catch (_) { return { raw: r.body.slice(0, 300) }; } };
let mods = null;
function appModules() { if (!mods) mods = require(path.join(ROOT, 'starnet', 'bin', 'lib', 'app-modules.js')).load(); return mods; }

async function getSave() {
  const r = j(await call('GET', '/api/save?agent=agent'));
  if (!r || !r.save) throw new Error('GET /api/save returned no save');
  return { doc: r.save, revision: r.head && r.head.revision };
}
// read-modify-write of the station save. fn(doc) mutates doc in place (return false to abort). Retries on conflict.
async function editSave(fn, label) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { doc, revision } = await getSave();
    if (fn(doc) === false) return null;
    doc.updatedAt = Date.now();
    doc._saveDirty = false;
    doc._saveClient = String(label || 'crew') .replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40) + '-' + Date.now();
    if (revision != null) doc._saveRevision = revision;
    const r = j(await call('POST', '/api/save', doc));
    if (r && r.ok) return r.revision;
    if (!(r && r.conflict)) throw new Error('POST /api/save failed: ' + JSON.stringify(r).slice(0, 200));
  }
  throw new Error('POST /api/save kept conflicting; is a station page open?');
}
function rows(doc) {
  const by = new Map();
  for (const x of (doc.agents || [])) if (x && x.id) by.set(String(x.id), x);
  if (doc.agent && doc.agent.id) by.set(String(doc.agent.id), doc.agent);   // the hero lives twice; doc.agent wins
  return by;
}
function rosterRows() { try { return JSON.parse(fs.readFileSync(path.join(W, 'agent.roster.json'), 'utf8')).agents || []; } catch (_) { return []; } }
// crew titles for the lead's YOUR CREW line: company/tools/loops.json titles, else the roster tagline
function crewTitles() {
  const out = new Map();
  try { for (const [id, c] of Object.entries(co.crew())) if (c && c.title) out.set(id, c.title); } catch (_) {}
  return out;
}
function compose(doc, agentId) {
  const M = appModules();
  const by = rows(doc);
  const rec = by.get(String(agentId));
  if (!rec) throw new Error('no save row for ' + agentId);
  const titles = crewTitles();
  const tag = new Map(rosterRows().map(r => [r.agentId, r.role]));
  const crew = [...by.values()].filter(x => x !== rec).map(x => Object.assign({}, x, { purpose: titles.get(x.id) || tag.get(x.id) || x.purpose }));
  const D = M.Dossier;
  const block = D.composeBlock(D.hydrate ? D.hydrate(doc.dossier) : doc.dossier);
  let system = M.composer.compose(Object.assign({}, rec), { crew, dossierBlock: block });
  const live = (rosterRows().find(r => r.agentId === String(agentId)) || {}).system || '';
  const k = live.indexOf(FORK); if (k >= 0) system += live.slice(k);   // the page appends its fork directive; keep it
  return { system, personaId: rec.personaId || 'composed' };
}
async function syncPrompt(agentId, doc) {
  const d = doc || (await getSave()).doc;
  const { system, personaId } = compose(d, agentId);
  const r = j(await call('POST', '/api/agent/personality', { agentId, personality: personaId, system }));
  if (!r || !r.ok) throw new Error('personality push failed for ' + agentId + ': ' + JSON.stringify(r).slice(0, 200));
  if (r.via && r.via !== 'roster') throw new Error('a station page is open (via:' + r.via + '); the composed prompt was ignored. Close the page and rerun.');
  const live = (rosterRows().find(x => x.agentId === String(agentId)) || {}).system || '';
  return { agentId, via: r.via || null, chars: system.length, applied: live === system };
}
// When a station page is open, headless crew changes reach it only after it reloads (it would otherwise push its stale
// crew back over them). The owner's station tab is bound to the opencli session "station"; save it, then reload it.
// Best effort: returns false when opencli or the bound tab is not there. Never touches any other tab.
// True while the owner is in a conversation in the station tab (an interactive run that is not a hire.js interview).
async function pageBusy() {
  try {
    const snap = JSON.parse((await call('GET', '/api/state/snapshot')).body || '{}');
    // hire.js interviews also run as 'interactive' (streamId interview-...); only a real conversation in the tab blocks
    return (snap.runs || []).some(r => r && r.source === 'interactive' && !r.internal && !String(r.streamId || '').startsWith('interview-'));
  } catch (_) { return false; }
}
// Read-only JavaScript in the owner's station tab (opencli session "station"). Returns the printed result as text, or
// null when opencli or the tab is not there. Callers must pass expressions that only read; never click or navigate.
function pageEval(js, timeoutMs) {
  try {
    return require('child_process').execFileSync('opencli', ['browser', 'eval', '--session', 'station', String(js)],
      { encoding: 'utf8', timeout: timeoutMs || 30000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (_) { return null; }
}
async function reloadStationPage() {
  // the owner may be mid-conversation in that tab: never reload over an interactive run
  if (await pageBusy()) return 'busy';
  try {
    const js = "(async () => { try { if (typeof CloudSave !== 'undefined') await CloudSave.flush({ force: true }); setTimeout(() => location.reload(), 200); return 'reloading'; } catch (e) { return 'ERR ' + e.message; } })()";
    const outp = require('child_process').execFileSync('opencli', ['browser', 'eval', '--session', 'station', js], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
    return /reloading/.test(outp) ? 'reloaded' : 'failed';
  } catch (_) { return 'failed'; }
}
module.exports = { call, getSave, editSave, rows, compose, syncPrompt, rosterRows, appModules, reloadStationPage, pageBusy, pageEval };

if (require.main === module) {
  const a = process.argv.slice(2); const cmd = a[0] || 'list';
  const opt = k => { const i = a.indexOf('--' + k); return i >= 0 ? (a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true) : null; };
  (async () => {
    if (cmd === 'list') {
      const { doc, revision } = await getSave(); const roster = new Map(rosterRows().map(r => [r.agentId, r]));
      console.log(JSON.stringify({ revision, station: doc.station && doc.station.meta && doc.station.meta.name, agents: [...rows(doc).values()].map(x => ({ id: x.id, name: x.name, approvalSave: x.approvalMode, approvalRoster: (roster.get(x.id) || {}).approvalMode, model: x.model, provider: x.provider, skin: x.skin, identity: String((x.docs && x.docs.identity) || '').slice(0, 60) })) }, null, 1));
      return;
    }
    if (cmd === 'sync') {
      const { doc } = await getSave();
      const ids = opt('all') ? [...rows(doc).keys()] : [String(opt('agent') || '')].filter(Boolean);
      if (!ids.length) throw new Error('--agent <id> or --all');
      for (const id of ids) console.log(JSON.stringify(await syncPrompt(id, doc)));
      return;
    }
    throw new Error('commands: list, sync');
  })().catch(e => { console.error(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });
}
