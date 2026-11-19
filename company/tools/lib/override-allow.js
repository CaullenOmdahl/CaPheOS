'use strict';
/* lib/override-allow.js — the station's one-run override allowlist: company/state/override-allow.json.
 *
 * StarNet patch 0017 (company/patches/0017-per-run-model.diff) lets POST /api/cron/run and a team.dispatch worker spec
 * name a {provider, model, effort} for ONE run. The station accepts such an override only when this file, named by the
 * station env STARNET_OVERRIDE_ALLOW (scripts/setup-station.sh writes it), opens that (provider, model) for the run's own
 * agent, and only while the file is less than 30 minutes old. Without the file every override is refused. That keeps a
 * lead agent or a Run Now caller from routing around the company's model rules: what a seat may run on is decided here,
 * by the same rules the failover tick uses, never by the caller.
 *
 * The dispatcher writes it at the end of every tick (company/tools/dispatch.js). For each crew seat (company/tools/loops.json):
 *   - the entries of its chain (company/model-policy.json seats.<id>.chain), and
 *   - if company/departments.json exists, the route models of the seat's department (routes values, docs/DEPARTMENTS.md),
 *   - with a routing policy (company/work/models/routing-policy.json, lib/routing.js): the arms of every running trial the
 *     seat is in scope of (mode not off), and its capped chain entries while tierCaps.mode is live (non-exempt seats);
 *     a route or trial arm the policy's classRules deny for its class (code on provider custom) is never listed,
 * kept only when models.js evaluate() says the entry can run NOW for that seat (on the allowed list, connected, the pacer
 * gate open incl. the owner's subscription stops, no quota closure, no refusal block, no budget or provider-error hold).
 * Nothing outside those is ever listed; a seat with nothing runnable gets []. Effort is not listed (the station leaves it
 * free). Without a pacer measurement every seat gets [] (fail closed).
 *
 *   { "v": 1, "at": <epoch ms>, "by": "dispatcher", "agents": { "<agentId>": [ { "provider": "...", "model": "..." } ] } }
 *
 *   const OA = require('./lib/override-allow');
 *   await OA.build({ root?, now?, call?, jobs?, m?, providers?, blocks? }) -> the document (not written)
 *   await OA.write({ ...same, log?, dry? })                               -> { ok, file, seats, open, why? }
 *   OA.departmentRoutes(seatId, { root? })                                 -> [{ provider, model, effort? }] (none: [])
 *   OA.openFor(agentId, { provider, model }, { root?, now?, ownerPick? })  -> null (open) | a plain reason it is not
 *     ownerPick: the owner chose this model for a console-started run; open when the seat has that provider open now
 *     the station's own test, for a caller that starts a run itself (the console's meeting with one model picked for
 *     everyone, console/meeting.js): the file must be under 30 minutes old and list that pair for that agent
 *
 * Regenerated on every tick: locked-watch.js class R (writer lib/override-allow.js; a foreign write is regenerated), and
 * retention keeps no history of it (rewritten whole). Never throws from write(). CLI: `node company/tools/lib/override-allow.js
 * write|show`.
 */
const fs = require('fs');
const path = require('path');
const co = require('./company');

const REL = 'company/state/override-allow.json';
const WRITER = 'lib/override-allow.js';   // the provenance writer name locked-watch.js checks (class R)
const fileOf = root => path.join(path.resolve(root || co.ROOT), REL);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };

/* The seat's department route models (company/departments.json; a missing or broken file means none). With a routing policy
   (lib/routing.js), a route its class rules deny for its own class (code on provider custom) is left out. */
function departmentRoutes(seatId, o) {
  const doc = readJson(path.join(path.resolve((o && o.root) || co.ROOT), 'company', 'departments.json'), null);
  const list = doc && Array.isArray(doc.departments) ? doc.departments.filter(d => d && typeof d === 'object') : [];
  const s = String(seatId || '');
  const d = list.find(x => Array.isArray(x.members) && x.members.map(String).includes(s)) || list.find(x => x.lead && String(x.lead) === s);
  if (!d || !d.routes || typeof d.routes !== 'object') return [];
  const K = o && o.K !== undefined ? o.K : routingKnobs(o && o.root);
  return Object.entries(d.routes).filter(([c, r]) => r && typeof r === 'object' && r.provider && r.model && require('./routing').routeAllowed(c, { provider: String(r.provider), model: String(r.model) }, K))
    .map(([, r]) => Object.assign({ provider: String(r.provider), model: String(r.model) }, r.effort ? { effort: String(r.effort) } : {}));
}
/* the routing policy's knobs (lib/routing.js; none = null: no class rules, no trial arms, no tier-cap entries) */
function routingKnobs(root) { try { const R = require('./routing'); const L = R.loadPolicy(path.resolve(root || co.ROOT)); return L ? R.knobs(L.policy) : null; } catch (_) { return null; } }

async function build(o) {
  o = o || {};
  const root = path.resolve(o.root || co.ROOT);
  const M = require('../models.js').makeModels({ root, call: o.call, now: o.now, quiet: true, dry: true });
  const K = routingKnobs(root);
  const deps = K ? require('./departments').load({ root }).doc : null;
  const crew = K ? ((readJson(path.join(root, 'company', 'tools', 'loops.json'), {}) || {}).agents || {}) : null;
  const R = require('./routing');
  const r = await M.runnableNow({
    jobs: o.jobs, m: o.m, providers: o.providers, blocks: o.blocks,
    // chain + department routes + (with a routing policy) running trial arms and live tier-cap entries for in-scope seats;
    // every one still has to pass evaluate() (runnableNow) to be listed
    entriesFor: (id, seat) => ((seat && seat.chain) || []).concat(departmentRoutes(id, { root, K })).concat(K ? R.extraEntries(id, { root, K, departments: deps, crew, chain: (seat && seat.chain) || [] }) : [])
  });
  const at = typeof o.now === 'function' ? o.now() : Date.now();
  return { doc: { v: 1, at, by: 'dispatcher', agents: r.seats || {} }, ok: r.ok, why: r.why || null };
}

async function write(o) {
  o = o || {};
  const file = fileOf(o.root);
  try {
    const b = await build(o);
    const ids = Object.keys(b.doc.agents);
    const open = ids.reduce((n, id) => n + b.doc.agents[id].length, 0);
    if (!o.dry) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const txt = JSON.stringify(b.doc, null, 1) + '\n';
      const tmp = file + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, txt); fs.renameSync(tmp, file);
      try { require('../provenance.js').wrote(file, txt, WRITER); } catch (_) {}   // locked-watch.js: this tool's own write
    }
    if (!b.ok && typeof o.log === 'function') o.log('OVERRIDE ALLOWLIST: ' + b.why + ' (every seat [] this tick)');
    return { ok: b.ok, file, seats: ids.length, open, why: b.why };
  } catch (e) {
    // fail closed: an empty list (nothing open for anyone); if even that cannot be written the file goes stale within
    // 30 minutes and the station turns every override off
    if (!o.dry) { try { const tmp = file + '.tmp-' + process.pid, txt = JSON.stringify({ v: 1, at: Date.now(), by: 'dispatcher', agents: {} }, null, 1) + '\n'; fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(tmp, txt); fs.renameSync(tmp, file); try { require('../provenance.js').wrote(file, txt, WRITER); } catch (_) {} } catch (_) {} }
    if (typeof o.log === 'function') o.log('OVERRIDE ALLOWLIST ERROR: ' + String((e && e.message) || e).slice(0, 200) + ' (nothing open this tick)');
    return { ok: false, file, error: String((e && e.message) || e) };
  }
}

/* is (provider, model) open for this agent now? The station's rule (patch 0017): the file must exist, be less than 30
   minutes old and list the pair for the agent; anything else is closed. -> null when open, else a plain reason */
const MAX_AGE_MS = 30 * 60e3;
function openFor(agentId, pair, o) {
  o = o || {};
  const doc = readJson(fileOf(o.root), null);
  const now = typeof o.now === 'function' ? o.now() : Number(o.now) || Date.now();
  if (!doc || typeof doc !== 'object' || !doc.agents || typeof doc.agents !== 'object') return 'no current list of the models each person may use';
  if (!(Number(doc.at) > 0) || now - Number(doc.at) > MAX_AGE_MS) return 'the list of the models each person may use is out of date';
  const list = Array.isArray(doc.agents[String(agentId || '')]) ? doc.agents[String(agentId)] : [];
  const p = pair || {};
  if (list.some(x => x && x.provider === p.provider && x.model === p.model)) return null;
  // the owner's own pick for a run the console starts itself (a meeting or chat with one model for everyone, o.ownerPick):
  // the pair is on the company's allowed list (the caller checks) and need not be in the seat's chain. It is open when
  // the seat has some entry of the SAME provider open now: that entry passed evaluate() this tick (connected, the pacer
  // gate incl. the owner's subscription stops, no quota closure, no refusal block for the seat, no budget or provider-error
  // hold), and those are per provider, not per model. A provider with nothing open for the seat stays closed.
  if (o.ownerPick && list.some(x => x && x.provider === p.provider)) return null;
  return o.ownerPick ? 'not open for them right now (' + (list.length ? 'that AI provider is closed for them' : 'no AI is open for them') + ')' : 'not open for them right now';
}

module.exports = { build, write, departmentRoutes, openFor, MAX_AGE_MS, REL, WRITER };

// node company/tools/lib/override-allow.js [write|show]   write: one rewrite now (locked-watch.js regenerates it so);
// show: print what would be written. Reads the station's routines itself.
if (require.main === module) {
  const cmd = process.argv[2] || 'write';
  (async () => {
    if (cmd === 'show') { const b = await build({}); console.log(JSON.stringify(b.doc, null, 1)); if (!b.ok) console.error(b.why); return; }
    if (cmd !== 'write') { console.error('usage: node company/tools/lib/override-allow.js [write|show]'); process.exit(2); }
    const r = await write({ log: l => console.error(l) });
    console.log('override allowlist: ' + (r.error ? 'nothing open (' + r.error + ')' : r.open + ' open pair(s) over ' + r.seats + ' seat(s)') + ' -> ' + REL);
    process.exit(r.ok ? 0 : 1);
  })().catch(e => { console.error(e.message); process.exit(1); });
}
