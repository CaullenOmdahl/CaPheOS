#!/usr/bin/env node
/* station-seed.js — give a station whose page never ran (StarNet headless, CaPheOS patch 0010) its save and its Founder.
 *
 * Why this exists: StarNet's page creates the station SAVE on first boot and pushes the ROSTER when the Overseer wakes.
 * A headless station never serves that page, so it has neither: GET /api/save answers {save:null}, the roster is empty,
 * and the "Founder" is only the engine's implicit default agent, with no dossier and no approval mode. Then
 *   - unattended routine writes into the blessed company folder are refused ("unattended runs can't self-approve");
 *   - hire.js, station-crew.js and dossier.js stop at "GET /api/save returned no save".
 * StarNet itself has a headless founding: its terminal awakening (starnet/bin/lib/awaken.js, WAKE) writes exactly what the
 * page's onWakeAttempt + enterGame write, through the same routes, with the app's own modules
 * (starnet/bin/lib/app-modules.js). This tool runs that WAKE without the interactive ceremony:
 *   - the Overseer row (id 'agent', role orchestrator) in awaken.js's shape, its docs from app.js agentDocs (composer.docs);
 *   - the starter station: WorldModel.create(WorldModel.starterDoc()), meta.name = the company name, the desk adopted with
 *     ensureWorkstation('agent');
 *   - a fresh Commander dossier (Dossier.fresh + seedFromDocs) and profile (Profile.fresh), the envelope from Save.envelope;
 *   - POST /api/save (onboarded:false: it founds the station in the sidecar's record), POST /api/roster with the app's
 *     composed prompt, POST /api/dossier + /api/autonomy/posture (beliefs), then the dawn save (onboarded:true).
 * The Founder's docs come from its charter (company/roles/agent.md) through dossier.js build(), its name and title from
 * company/tools/loops.json, its model from the Founder loop routine (else model-policy.json candidateDefault).
 * NOT run: the awakening's LOCK DOWN (revoke inherited grants, fresh autonomy posture, journey and memory reset). On a
 * company station those grants, the posture and the Founder's notebook are the company's own setup; resetting them
 * would undo onboarding and erase memory. Nor the interview (the console's charter conversation replaces it).
 *
 * Approval mode, from self-governance (never asked of the station page):
 *   full  when co.gate('tools') is auto or notify AND the harnessSelfEdit guardrail lets unattended writes into the blessed
 *         root stand: the guardrail is off, or it is on and locked-watch.js holds a baseline (company/state/locked/
 *         baseline.json), so a write to a locked file is still put back or reported;
 *   ask   otherwise, with the reason. The execution profile is trusted-project (workspace + blessed project folders)
 *         while the localComputer guardrail is on, this-computer only when the owner turned it off.
 *
 *   node company/tools/station-seed.js status [--json]           save? roster agents? approval modes? what is missing
 *   node company/tools/station-seed.js seed --by <owner> [--provider P --model M] [--dry] [--json]
 *        idempotent: creates the save only when there is none; fills only the Founder's empty or stock docs; changes the
 *        approval mode only when self-governance says another one (a change on an existing roster row is reported by
 *        locked-watch.js as an approval-mode change, as it should be)
 *   node company/tools/station-seed.js selftest                  offline: tests/mock-station.js --fresh + the StarNet
 *                                                                 stub (and the real StarNet modules when ROOT/starnet has them)
 * The station page must be closed while this writes (station-crew.js). Exit: 0 ok/seeded, 1 something missing/failed, 2 usage.
 * Owner of this tool: the tools function holder.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const co = require('./lib/company');
const C = require('./station-crew.js');

const ROOT = co.ROOT;
const HERO = 'agent';
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const j = r => { try { return JSON.parse(r.body); } catch (_) { return null; } };
const ok = r => !!(r && r.status === 200 && j(r) && j(r).ok !== false);

function seat() {
  const c = co.crew()[HERO];
  if (!c) throw new Error('company/tools/loops.json has no seat "' + HERO + '" (the Founder); found-company.sh writes it');
  return { name: c.name || 'Founder', title: c.title || 'Founder and CEO', row: c };
}
function stationName() { return String(co.config.name || co.config.shortName || 'CaPheOS company').trim().slice(0, 40); }

/* the approval mode self-governance gives the Founder, and why */
function approvalDecision() {
  const level = co.gate('tools');
  const selfEdit = co.guard('harnessSelfEdit');
  const baseline = co.p('company', 'state', 'locked', 'baseline.json');
  const watched = fs.existsSync(baseline);
  const localOn = co.guard('localComputer');
  const facts = { toolsGate: level, harnessSelfEdit: selfEdit ? 'on' : 'off', lockedWatchBaseline: watched, localComputer: localOn ? 'on' : 'off' };
  // A loop seat runs unattended: in StarNet's "ask" mode nobody is there to click approve, so every write is refused and
  // the loop can do nothing. What bounds the crew is the guardrails and self-governance, enforced by the tools whatever
  // the station's approval mode (harness-change.js gates tool/policy changes, locked-watch puts locked files back, the
  // external gate holds anything leaving). So the Founder is always 'full'; "approve everything" means the owner
  // approves decisions, not file writes. With harnessSelfEdit on, locked-watch needs a baseline first: take it here.
  const mode = 'full'; let why;
  if (selfEdit && !watched) {
    try { require('child_process').execFileSync(process.execPath, [co.p('company', 'tools', 'locked-watch.js'), 'baseline'], { cwd: co.ROOT, stdio: 'ignore', timeout: 60000 }); } catch (_) {}
    facts.lockedWatchBaseline = fs.existsSync(baseline);
  }
  why = 'unattended loop seats run on full approval (an "ask" seat with nobody to click approve can do nothing); the crew stays bounded by self-governance (tools is "' + level + '"'
    + (['auto', 'notify'].includes(level) ? '' : ': shared tool and policy changes still wait for the owner through harness-change.js') + ') and the guardrails'
    + (selfEdit ? (facts.lockedWatchBaseline ? ' (harnessSelfEdit on: locked-watch holds a baseline and puts locked files back)' : ' (harnessSelfEdit on, but locked-watch could not take a baseline yet: run `node company/tools/locked-watch.js baseline`)') : ' (harnessSelfEdit off)');
  const executionProfile = mode === 'full' && !localOn ? 'this-computer' : 'trusted-project';
  return { mode, executionProfile, why: why + '; execution profile ' + executionProfile + (localOn ? ' (localComputer guardrail on: workspace + blessed project folders only)' : ' (localComputer guardrail off)'), facts };
}

/* the Founder's model: its loop routine's, else the candidate default */
async function founderModel(o) {
  if (o.provider && o.model) return { provider: String(o.provider), model: String(o.model), from: 'flags' };
  try {
    const r = j(await C.call('GET', '/api/cron'));
    const loop = seat().row.loop || 'Founder loop';
    const hit = ((r && r.jobs) || []).find(x => x && x.agentId === HERO && typeof x.name === 'string' && x.name.startsWith(loop) && x.model);
    if (hit) return { provider: hit.provider || null, model: hit.model, from: 'routine ' + hit.name };
  } catch (_) {}
  const cd = (readJson(co.p('company', 'model-policy.json'), {}) || {}).candidateDefault || {};
  return { provider: cd.provider || null, model: cd.model || null, from: 'model-policy.json candidateDefault' };
}

/* the docs the Founder should carry: dossier.js build() from company/roles/agent.md; a doc already written by hand stays */
function docsFor(rec, M) {
  const D = require('./dossier.js');
  const s = seat();
  const b = D.build(HERO, s.row, rec);
  const cur = (rec && rec.docs) || {};
  let stock = ''; try { stock = M.composer.identity(rec.name, rec.role); } catch (_) {}
  const blank = k => !String(cur[k] || '').trim() || (k === 'identity' && (String(cur[k]) === stock || /aboard the STARNET station/.test(String(cur[k]))));
  const next = {}, filled = [];
  for (const k of ['identity', 'purpose', 'context', 'manual']) { if (blank(k)) { next[k] = b[k]; filled.push(k); } else next[k] = cur[k]; }
  return { docs: next, filled, personaId: b.personaId, customVoice: b.customVoice };
}

function rosterRow(rec, system, title) {
  // awaken.js pushRoster's row, field for field
  return { agentId: rec.id, system, name: rec.name, model: rec.model || '', provider: rec.provider || '', role: String(rec.purpose || title || 'general specialist').slice(0, 120),
    approvalMode: rec.approvalMode === 'full' ? 'full' : 'ask', executionProfile: rec.executionProfile, track: '', workshop: !!rec.workshop, skills: [], reasoningEffort: rec.reasoningEffort || null };
}
async function pushRoster(doc, rec, title) {
  const { system } = C.compose(doc, rec.id);
  const others = C.rosterRows().filter(x => x && x.agentId !== rec.id);
  const r = await C.call('POST', '/api/roster', { agents: [rosterRow(rec, system, title)].concat(others), updatedAt: Date.now() }, 15000);
  if (!ok(r)) throw new Error('the station did not take the roster: ' + String(r.body).slice(0, 200));
  return system.length;
}
// awaken.js pushDossier: the dossier block and the beliefs snapshot the autonomy posture reads
async function pushDossier(M, dz) {
  const D = M.Dossier;
  await C.call('POST', '/api/dossier', { block: D.composeBlock(dz) }, 10000);
  const snap = {}, known = [];
  for (const k of D.DIM_KEYS || []) {
    const arr = (D.beliefs(dz, k) || []).map(b => ({ text: String((b && b.text) || ''), weight: D.weightOf(b), updatedAt: Number(b && b.updatedAt) || 0, createdAt: Number(b && b.createdAt) || 0 }));
    if (arr.length) { snap[k] = arr; known.push(k); }
  }
  const rd = M.Understanding && M.Understanding.readiness ? M.Understanding.readiness(dz) : null;
  await C.call('POST', '/api/autonomy/posture', { beliefs: { known, beliefs: snap, ready: rd ? { ok: !!rd.ready, reasons: Array.isArray(rd.reasons) ? rd.reasons : [] } : null } }, 10000);
}
async function postSave(M, state) {
  const r = await C.call('POST', '/api/save', M.Save.envelope ? M.Save.envelope(state) : state, 20000);
  const b = j(r);
  if (!(r.status === 200 && b && b.ok !== false)) throw new Error('the station did not take the save: ' + String(r.body).slice(0, 200));
  return b.revision;
}

/* ---------------- status ---------------- */
async function status() {
  const out = { ok: false, station: co.STATION_URL, problems: [] };
  let r;
  try { r = await C.call('GET', '/api/save?agent=' + HERO, null, 10000); } catch (e) { out.problems.push({ code: 'station-down', fix: 'start the station (systemctl --user start ' + (co.config.station.serviceName || 'capheos-station') + ')', error: e.message }); return out; }
  const b = j(r) || {};
  const save = b.save || null;
  out.save = save ? { present: true, revision: b.head && b.head.revision, station: save.station && save.station.meta && save.station.meta.name, onboarded: !!(save.agent && save.agent.onboarded) } : { present: false, lineage: b.lineage ? { onboardingAllowed: b.lineage.onboardingAllowed, station: b.lineage.station } : null };
  const hero = save && save.agent && save.agent.id === HERO ? save.agent : null;
  out.founder = hero ? { name: hero.name, approvalMode: hero.approvalMode, executionProfile: hero.executionProfile, model: hero.model, provider: hero.provider,
    docs: Object.fromEntries(['identity', 'purpose', 'context', 'manual'].map(k => [k, String((hero.docs && hero.docs[k]) || '').length])) } : null;
  const roster = C.rosterRows();
  out.roster = roster.map(x => ({ agentId: x.agentId, name: x.name, approvalMode: x.approvalMode, executionProfile: x.executionProfile, model: x.model, provider: x.provider, systemChars: String(x.system || '').length }));
  const want = approvalDecision();
  out.approval = { want: want.mode, executionProfile: want.executionProfile, why: want.why };
  if (!save) out.problems.push({ code: 'no-save', fix: 'node company/tools/station-seed.js seed --by <owner>' });
  else if (!hero) out.problems.push({ code: 'no-founder-in-save', fix: 'node company/tools/station-seed.js seed --by <owner>' });
  const row = roster.find(x => x.agentId === HERO);
  if (!row) out.problems.push({ code: 'no-founder-in-roster', fix: 'node company/tools/station-seed.js seed --by <owner>' });
  if (hero && hero.approvalMode !== want.mode) out.problems.push({ code: 'save-approval', have: hero.approvalMode, want: want.mode, fix: 'node company/tools/station-seed.js seed --by <owner>' });
  if (row && row.approvalMode !== want.mode) out.problems.push({ code: 'roster-approval', have: row.approvalMode, want: want.mode, fix: 'node company/tools/station-seed.js seed --by <owner>' });
  if (hero) { try { const p = docsFor(hero, C.appModules()).filled; if (p.length) out.problems.push({ code: 'founder-docs', empty: p, fix: 'node company/tools/station-seed.js seed --by <owner>' }); } catch (e) { out.problems.push({ code: 'founder-docs', error: e.message }); } }
  out.ok = !out.problems.length;
  return out;
}

/* ---------------- seed ---------------- */
async function seed(o) {
  const by = String(o.by || '').trim();
  if (!by) throw new Error('--by <owner> is required');
  const M = C.appModules();
  const AgentId = require(path.join(ROOT, 'starnet', 'frontend', 'app', 'agentid.js'));
  const s = seat();
  const want = approvalDecision();
  const done = [];
  const r0 = await C.call('GET', '/api/save?agent=' + HERO, null, 15000);
  const b0 = j(r0);
  if (r0.status !== 200 || !b0) throw new Error('GET /api/save failed: HTTP ' + r0.status + ' ' + String(r0.body).slice(0, 200));
  let doc = b0.save || null;
  const name = AgentId.normalizeName(s.name).slice(0, 18);
  if (!doc) {
    if (b0.lineage && b0.lineage.onboardingAllowed === false) throw new Error('the station reports a prior station here (lineage onboardingAllowed:false); recover it in StarNet instead of founding a new one: ' + JSON.stringify(b0.lineage).slice(0, 300));
    const wire = await founderModel(o);
    if (!wire.model || !wire.provider) throw new Error('no model for the Founder: pass --provider and --model, or set candidateDefault in company/model-policy.json');
    const epoch = Date.now();
    // awaken.js wake(): the Overseer
    const agent = { id: HERO, name, role: 'orchestrator', color: '#ffd34a', skin: undefined, model: wire.model, provider: wire.provider,
      reasoningEffort: 'medium', personaId: M.Personas.DEFAULT_ID || 'composed', voiceTraits: {}, customVoice: '', approvalMode: want.mode,
      executionProfile: want.executionProfile, purpose: null, onboarded: false, createdAt: epoch };
    M.composer.docs(agent);
    const d = docsFor(agent, M);
    agent.docs = Object.assign(agent.docs, d.docs);
    agent.purpose = String(d.docs.purpose || '').trim() || null;
    if (d.personaId && (!M.Personas.exists || M.Personas.exists(d.personaId))) agent.personaId = d.personaId;
    if (d.customVoice) agent.customVoice = d.customVoice;
    const station = M.WorldModel.create(M.WorldModel.starterDoc());
    station.doc().meta.name = stationName();
    const desk = station.ensureWorkstation(HERO);
    const dossier = M.Dossier.fresh();
    M.Dossier.seedFromDocs(dossier, agent.docs, Date.now(), { resync: true });
    const state = { _saveDirty: true, _saveRevision: 0, _saveClient: 'station-seed-' + epoch, agent, usage: { tokens: 0, cost: 0, calls: 0 }, prov: agent.provider,
      reasoningEffort: agent.reasoningEffort, reasoningMigrated: '0125', station: station.serialize(), profile: M.Profile.fresh(), dossier };
    if (o.dry) return { ok: true, dry: true, would: ['create the station save "' + stationName() + '"', 'Founder ' + name + ' on ' + wire.provider + '/' + wire.model + ' (' + wire.from + ')', 'approval ' + want.mode], approval: want };
    // the save first (onboarded:false): it founds the station in the sidecar's record (awaken.js wake)
    let rev = await postSave(M, state);
    done.push('save created (revision ' + rev + ', station "' + stationName() + '", desk ' + ((desk && desk.id) || '?') + ')');
    const cur = j(await C.call('GET', '/api/save?agent=' + HERO, null, 15000));
    doc = cur && cur.save;
    if (!doc) throw new Error('the station took the save but GET /api/save still answers none');
    await pushRoster(doc, doc.agent, s.title);
    done.push('roster: Founder pushed with the composed prompt (approval ' + want.mode + ')');
    await pushDossier(M, M.Dossier.hydrate ? M.Dossier.hydrate(doc.dossier) : doc.dossier);
    done.push('dossier block and beliefs pushed');
    // DAWN: the setup is the company's (the console charter conversation), so the page opens onto an onboarded station
    rev = await C.editSave(x => { x.agent.onboarded = true; }, 'station-seed');
    done.push('Founder onboarded (revision ' + rev + ')');
  } else {
    // a save exists: make sure the Founder in it is complete and on the mode self-governance gives it
    const hero = doc.agent && doc.agent.id === HERO ? doc.agent : null;
    if (!hero) throw new Error('the station save has no Overseer row (agent.id "agent"); open the station page once or recover the save, this tool does not invent one into an existing station');
    const d = docsFor(hero, M);
    const changes = [];
    if (d.filled.length) changes.push('docs ' + d.filled.join(', ') + ' from ' + path.relative(ROOT, require('./dossier.js').charterFile(s.row, HERO)));
    if (hero.approvalMode !== want.mode) changes.push('approval ' + (hero.approvalMode || '(none)') + ' -> ' + want.mode);
    if (hero.executionProfile !== want.executionProfile) changes.push('execution profile ' + (hero.executionProfile || '(none)') + ' -> ' + want.executionProfile);
    if (o.dry) return { ok: true, dry: true, would: changes.length ? changes : ['nothing in the save'], approval: want };
    if (changes.length) {
      const rev = await C.editSave(x => {
        for (const h of [x.agent].concat((x.agents || []).filter(y => y && y.id === HERO && y !== x.agent))) {
          if (!h || h.id !== HERO) continue;
          if (d.filled.length) {
            h.docs = Object.assign({}, h.docs || {}, d.docs);
            if (d.filled.includes('purpose')) h.purpose = String(d.docs.purpose || '').trim() || h.purpose;
            if (d.personaId && !h.personaId) h.personaId = d.personaId;
            if (d.customVoice && !h.customVoice) h.customVoice = d.customVoice;
          }
          h.approvalMode = want.mode; h.executionProfile = want.executionProfile;
        }
        if (d.filled.length && x.dossier) { try { const dz = M.Dossier.hydrate(x.dossier); M.Dossier.seedFromDocs(dz, x.agent.docs, Date.now(), { resync: true }); x.dossier = dz; } catch (_) {} }
      }, 'station-seed');
      done.push('save: ' + changes.join('; ') + ' (revision ' + rev + ')');
      doc = j(await C.call('GET', '/api/save?agent=' + HERO, null, 15000)).save;
    }
  }
  // the roster row: present, on the right mode, carrying the composed prompt
  const row = C.rosterRows().find(x => x && x.agentId === HERO);
  if (!row) { await pushRoster(doc, doc.agent, s.title); done.push('roster: Founder pushed (approval ' + want.mode + ')'); }
  else {
    if (row.approvalMode !== want.mode || row.executionProfile !== want.executionProfile) { await pushRoster(doc, doc.agent, s.title); done.push('roster: approval ' + row.approvalMode + ' -> ' + want.mode); }
    else {
      const { system } = C.compose(doc, HERO);
      if (String(row.system || '') !== system) { const x = await C.syncPrompt(HERO, doc); done.push('roster: prompt recomposed (' + x.chars + ' chars)'); }
    }
  }
  if (done.length) {
    const f = co.p('company', 'hiring', 'staff-log.md');
    try { fs.mkdirSync(path.dirname(f), { recursive: true }); if (!fs.existsSync(f)) fs.writeFileSync(f, '# Staff log\n\nHires, model changes and departures. Written by company/tools/hire.js.\n\n');
      fs.appendFileSync(f, '- ' + new Date().toISOString() + ' FOUNDER SEAT seeded on the station by ' + by + ' (station-seed.js): ' + done.join('; ') + '. Approval ' + want.mode + ': ' + want.why + '\n'); } catch (_) {}
  }
  const st = await status();
  return { ok: st.ok, changed: done, approval: want, status: st };
}

/* ---------------- selftest ---------------- */
async function selftest() {
  const os = require('os');
  const { spawn, spawnSync } = require('child_process');
  const SRC = path.resolve(__dirname, '..', '..');
  const MOCK = path.join(SRC, 'tests', 'mock-station.js');
  const STUB = path.join(SRC, 'tests', 'fixtures', 'starnet-stub');
  let n = 0, bad = 0;
  const t = (name, cond, x) => { n++; if (!cond) bad++; console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond || x === undefined ? '' : ' :: ' + JSON.stringify(x).slice(0, 600))); };
  const free = () => new Promise(res => { const sv = require('net').createServer(); sv.listen(0, '127.0.0.1', () => { const p = sv.address().port; sv.close(() => res(p)); }); });
  const real = path.join(ROOT, 'starnet', 'bin', 'lib', 'app-modules.js');
  const variants = [{ label: 'stub', starnet: STUB, copy: true }];
  if (fs.existsSync(real) && fs.existsSync(path.join(ROOT, 'starnet', 'frontend', 'app', 'worldmodel.js'))) variants.push({ label: 'real StarNet modules', starnet: path.join(ROOT, 'starnet'), copy: false });
  for (const v of variants) {
    const T = require('./lib/temp-life').tmpDir('station-seed-selftest-');
    const mk = (rel, body) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body, null, 1)); };
    let mock = null;
    try {
      fs.cpSync(path.join(SRC, 'company', 'tools'), path.join(T, 'company', 'tools'), { recursive: true, filter: s => !/[\\/]tests[\\/]fixtures[\\/]/.test(s) });
      if (v.copy) fs.cpSync(v.starnet, path.join(T, 'starnet'), { recursive: true }); else fs.symlinkSync(v.starnet, path.join(T, 'starnet'));
      const port = await free(); if (port === 8800) throw new Error('refusing port 8800');
      mk('company/company.json', { name: 'Seed Test Co', owner: { name: 'Pat' }, timezone: 'UTC', station: { port } });
      mk('company/tools/loops.json', { agents: { agent: { name: 'Founder', title: 'Founder and CEO', role: 'agent.md', functions: ['ceo', 'people', 'tools', 'risk', 'floor', 'finance'], loop: 'Founder loop', inbox: 'to-founder.md', manager: null } } });
      mk('company/roles/agent.md', fs.readFileSync(path.join(SRC, 'company', 'roles', 'templates', 'founder.md'), 'utf8').replace(/\{\{OWNER\}\}/g, 'Pat').replace(/\{\{COMPANY\}\}/g, 'Seed Test Co'));
      mk('company/model-policy.json', { candidateDefault: { provider: 'deepseek', model: 'deepseek-flash' } });
      mk('company/state/governance.json', { categories: { tools: 'approve' }, fixed: {} });
      mk('company/state/guardrails.json', { guards: {} });
      mk('secrets/station-token', 'seed-test-token');
      mock = spawn(process.execPath, [MOCK, '--port', String(port), '--token', 'seed-test-token', '--root', T, '--fresh'], { stdio: ['ignore', 'pipe', 'inherit'] });
      await new Promise((res, rej) => { mock.stdout.once('data', res); mock.once('exit', c => rej(new Error('mock exited ' + c))); });
      const env = Object.assign({}, process.env, { CAPHEOS_ROOT: T, STARNET_URL: 'http://127.0.0.1:' + port });
      delete env.CAPHEOS_SECRET_STATION_TOKEN;
      const run = (...a) => { const r = spawnSync(process.execPath, [path.join(T, 'company', 'tools', a[0])].concat(a.slice(1)), { env, encoding: 'utf8', timeout: 60000 }); let o = null; try { o = JSON.parse(r.stdout); } catch (_) {} return { code: r.status, out: o, raw: (r.stdout || '') + (r.stderr || '') }; };
      const P = '[' + v.label + '] ';
      let r = run('station-seed.js', 'status', '--json');
      t(P + 'status on a headless station: no save, no Founder in the roster, exit 1', r.code === 1 && r.out && !r.out.save.present && r.out.problems.some(x => x.code === 'no-save') && r.out.problems.some(x => x.code === 'no-founder-in-roster'), r.raw);
      r = run('station-crew.js', 'list');
      t(P + 'station-crew.js list fails before the seed (the bug)', r.code !== 0 && /no save/.test(r.raw), r.raw);
      r = run('station-seed.js', 'seed', '--json');
      t(P + 'seed without --by is refused', r.code === 2, r.raw);
      r = run('station-seed.js', 'seed', '--by', 'Pat', '--json');
      t(P + 'seed with tools at approve: save + roster created, approval full with governance named', r.code === 0 && r.out.ok && r.out.approval.mode === 'full' && /tools is "approve"/.test(r.out.approval.why), r.raw);
      const S = () => JSON.parse(fs.readFileSync(path.join(T, '.starnet-data', 'workspaces', 'agent.roster.json'), 'utf8')).agents;
      const save = () => JSON.parse(run('station-crew.js', 'list').raw);
      let sv = save();
      t(P + 'the save carries the company as the station name and the Founder as the Overseer', sv.station === 'Seed Test Co' && sv.agents.length === 1 && sv.agents[0].id === 'agent' && sv.agents[0].name === 'FOUNDER' && sv.agents[0].approvalSave === 'full', sv);
      t(P + 'the Founder\'s identity is its charter, not the stock StarNet text', /FOUNDER, Founder and CEO at Seed Test Co/.test(sv.agents[0].identity) || /You are FOUNDER, Founder and CEO/.test(S()[0].system), sv.agents[0].identity);
      t(P + 'the roster has the Founder first, with the composed prompt and mode full', S()[0].agentId === 'agent' && S()[0].approvalMode === 'full' && /Founder and CEO/.test(S()[0].system) && S()[0].model === 'deepseek-flash', S()[0]);
      const st = JSON.parse(spawnSync('curl', ['-s', '-H', 'x-starnet-token: seed-test-token', 'http://127.0.0.1:' + port + '/__state'], { encoding: 'utf8' }).stdout || '{}');
      t(P + 'the save is founded onboarded:false, then the dawn save sets onboarded:true; dossier pushed', st.save && st.save.doc.agent.onboarded === true && st.save.revision === 2 && typeof st.dossierBlock === 'string' && st.posture && st.posture.beliefs, { rev: st.save && st.save.revision });
      r = run('station-seed.js', 'seed', '--by', 'Pat', '--json');
      t(P + 'a second seed changes nothing', r.code === 0 && r.out.changed.length === 0, r.raw);
      // the owner loosens tools; locked-watch has no baseline yet -> still ask, named
      mk('company/state/governance.json', { categories: { tools: 'auto' }, fixed: {} });
      r = run('station-seed.js', 'seed', '--by', 'Pat', '--json');
      t(P + 'tools auto, no locked-watch baseline, harnessSelfEdit on: baseline taken, full', r.code === 0 && r.out.approval.mode === 'full' && /baseline/.test(r.out.approval.why), r.raw);
      mk('company/state/locked/baseline.json', { files: {} });
      r = run('station-seed.js', 'seed', '--by', 'Pat', '--json');
      t(P + 'tools auto + baseline: approval full in save and roster, trusted-project (localComputer on)', r.code === 0 && r.out.approval.mode === 'full' && save().agents[0].approvalSave === 'full' && S()[0].approvalMode === 'full' && S()[0].executionProfile === 'trusted-project', r.raw);
      r = run('station-seed.js', 'status', '--json');
      t(P + 'status is green after the seed', r.code === 0 && r.out.ok && r.out.roster[0].approvalMode === 'full', r.raw);
      t(P + 'staff log records who seeded the Founder seat', /FOUNDER SEAT seeded on the station by Pat/.test(fs.readFileSync(path.join(T, 'company', 'hiring', 'staff-log.md'), 'utf8')));
      // hire.js can now create a candidate against the seeded save
      fs.mkdirSync(path.join(T, 'company', 'hiring', 'probe-1', 'interviews'), { recursive: true });
      mk('company/hiring/probe-1/round.json', { slug: 'probe-1', role: 'Probe', manager: 'agent', candidates: [] });
      mk('company/hiring/probe-1/role-spec.md', '# Probe\nScope: prove the save works.\n');
      mk('company/hiring/probe-1/log.md', '');
      mk('company/model-policy.json', { allowed: { deepseek: { models: ['deepseek-flash'] } }, candidateDefault: { provider: 'deepseek', model: 'deepseek-flash' } });
      r = run('hire.js', 'candidate', '--round', 'probe-1', '--name', 'PROBE', '--by', 'Pat');
      const hireOk = r.code === 0 && r.out && r.out.ok && S().some(x => x.agentId === r.out.agentId) && S()[0].agentId === 'agent';
      t(P + 'hire.js candidate works on the seeded station (the Founder stays first in the roster)', hireOk, r.raw);
    } catch (e) { t('[' + v.label + '] selftest ran', false, e.stack); }
    finally { if (mock) mock.kill(); fs.rmSync(T, { recursive: true, force: true }); }
  }
  console.log(bad ? 'STATION-SEED SELFTEST FAILED: ' + bad + ' of ' + n : 'STATION-SEED SELFTEST PASSED: ' + n + ' checks');
  return bad ? 1 : 0;
}

module.exports = { status, seed, approvalDecision, docsFor, rosterRow, stationName };

if (require.main === module) {
  const a = process.argv.slice(2); const cmd = a[0] || 'status';
  const opt = k => { const i = a.indexOf('--' + k); return i >= 0 ? (a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true) : null; };
  const json = a.includes('--json');
  const print = (code, o) => { console.log(JSON.stringify(o, null, json ? 0 : 1)); process.exit(code); };
  (async () => {
    if (cmd === 'selftest' || cmd === '--selftest') process.exit(await selftest());
    if (cmd === 'status') { const s = await status(); print(s.ok ? 0 : 1, s); }
    if (cmd === 'seed') {
      if (!opt('by') || opt('by') === true) print(2, { ok: false, error: '--by <owner> is required' });
      const r = await seed({ by: opt('by'), provider: opt('provider'), model: opt('model'), dry: !!opt('dry') });
      print(r.ok ? 0 : 1, r);
    }
    print(2, { ok: false, error: 'commands: status, seed --by <owner> [--provider P --model M] [--dry], selftest' });
  })().catch(e => print(1, { ok: false, error: e.message }));
}
