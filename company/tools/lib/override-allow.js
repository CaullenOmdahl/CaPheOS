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

/* The seat's department route models (company/departments.json; a missing or broken file means none). */
function departmentRoutes(seatId, o) {
  const doc = readJson(path.join(path.resolve((o && o.root) || co.ROOT), 'company', 'departments.json'), null);
  const list = doc && Array.isArray(doc.departments) ? doc.departments.filter(d => d && typeof d === 'object') : [];
  const s = String(seatId || '');
  const d = list.find(x => Array.isArray(x.members) && x.members.map(String).includes(s)) || list.find(x => x.lead && String(x.lead) === s);
  if (!d || !d.routes || typeof d.routes !== 'object') return [];
  return Object.values(d.routes).filter(r => r && typeof r === 'object' && r.provider && r.model)
    .map(r => Object.assign({ provider: String(r.provider), model: String(r.model) }, r.effort ? { effort: String(r.effort) } : {}));
}

async function build(o) {
  o = o || {};
  const root = path.resolve(o.root || co.ROOT);
  const M = require('../models.js').makeModels({ root, call: o.call, now: o.now, quiet: true, dry: true });
  const r = await M.runnableNow({
    jobs: o.jobs, m: o.m, providers: o.providers, blocks: o.blocks,
    entriesFor: (id, seat) => ((seat && seat.chain) || []).concat(departmentRoutes(id, { root }))
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

module.exports = { build, write, departmentRoutes, REL, WRITER };

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
