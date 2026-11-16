#!/usr/bin/env node
/* station-floor.js — the floor owner's tool: rooms, names, floor/wall/exterior paint, props, desks and seats, changed headlessly
 * with StarNet's own code (WorldModel + StationBuilder loaded in Node). No station page and no hand-off is needed.
 *
 * Why it works this way (written against StarNet v0.15.0):
 *  - The floor is save.station. The page rebuilds it from the save on load, and the server routes from the saved copy and
 *    holds a floor that does not round-trip (station-store.js:121-140). POST /api/save checks no geometry, so a hand edit can
 *    save a broken floor. So every change is PLANNED and APPLIED by StationBuilder (the code BUILD mode and the lead's
 *    station.build use) on a fresh GET inside station-crew.editSave, re-planned on every conflict retry, then read back.
 *  - StarNet's own checks miss things (a desk standing on another desk's seat; an unreachable room is only a warning), so
 *    `audit` adds checks A1-A10 and `apply` refuses any edit that makes A1-A7 worse or that StarNet only warns about.
 *    --allow-note waives only a StarNet warning; today StarNet warns about exactly two things (a new routing problem, a
 *    room nobody can walk into) and A6 and A5 refuse those anyway, so it matters only for warnings a later StarNet adds.
 *  - An open station page keeps its own copy and merges its next save over ours (its _nid and room order win), so after a
 *    write the page is reloaded (station-crew.reloadStationPage, which refuses during a conversation in the tab). While such
 *    a conversation runs, edits that add or remove rooms or props, or touch desks, capability props, room shapes or belts,
 *    wait (--wait-idle <min>); names, paint and decor moves go ahead because they survive the page's merge. When the run
 *    list (GET /api/state/snapshot) cannot be read, those edits are refused (exit 3), never guessed, and the page is not
 *    reloaded; when company/tools/loops.json cannot be read (A4 needs the crew), every edit is refused (exit 3).
 *  - Rules: never write r, m, w or h by hand (StarNet works them out); never change a capability prop's type; never remove
 *    the last prop of a capability (desks, files, web, memory, terminal, images).
 *
 *   node company/tools/station-floor.js show [--room <room>] [--json]
 *   node company/tools/station-floor.js audit [--strict]                    # A1-A10; exit 1 on a failure (--strict: warnings too)
 *   node company/tools/station-floor.js snapshot [--label <label>]          # company/floor_snapshots/<time>-<label>.json
 *   node company/tools/station-floor.js plan (--ops '<json list of refit ops>' | <ops.json>)   # dry run; writes nothing
 *   node company/tools/station-floor.js apply (--ops '<json>' | <ops.json>) --by <name> [--why "<reason>"] [--allow-note <text>] [--wait-idle <min>]
 *   Shorthands (each one is an apply; add --dry to only plan it):
 *     rename <room> <NAME> --by <name>
 *     paint <room> [--floor <style>/<mat>] [--walls <style|follow>/<mat>] [--hull <style|follow>/<mat>] --by <name>
 *     move <prop> <x> <y> --by <name>                 place <type> <x> <y> [--r 0-3] --by <name>        remove <prop> --by <name>
 *     seat <desk> <agentId|nobody> --by <name>
 *     room add <NAME> <x> <y> <w> <h> [--kind hab|bridge|lab|factory|quarters|storage] --by <name>
 *     room resize <room> <x> <y> <w> <h> | room move <room> <x> <y> | room kind <room> <kind> | room remove <room>   (--by <name>)
 *     hall add <x> <y> <w> <h> | hall remove <hall>   (--by <name>)
 *   node company/tools/station-floor.js restore <snapshot.json> --by <name> [--drop-new] [--dry]
 *   node company/tools/station-floor.js doc                                 # rewrite FLOOR_PLAN.md section 2 from the live save
 *
 * Rooms are named by id (r12) or name (LOBBY, CORRIDOR-3); props by id (p40) or tile (8,2); coordinates are world tiles.
 * The refit ops are StarNet's (stationbuilder.js REFIT_OPS: room, hall, resize, move, delete, rename, type, floor, walls,
 * hull, paint, place, agent, ...); a corridor named in an op's "room" is turned into its id (StarNet resolves only room
 * names). apply writes a snapshot first, logs to company/floor_snapshots/log.md and runs doc, which also carries a room
 * rename into FLOOR_PLAN.md section 1 (the "- **NAME**" lines) and the section 7 camera route.
 * Exit codes: 0 done (or nothing to change); 1 an error, or `audit` found a failure; 2 refused, nothing written;
 * 3 not now, nothing written: a conversation is running in the station tab, or the run list or loops.json could not be
 * read (run it again later, or add --wait-idle <min>); 4 written, but the read-back or the page's reload lost part of it
 * (see readBack and stationPage; the snapshot it names puts the floor back; run the command again).
 * Module: const F = require('./station-floor.js'); F.checkDesk(station, agentId[, { rows, name, title }])
 *         -> { ok, problems: [{ code, msg }], desk, seat, department, suggest }   (used by hire.js)
 * Tests: STATION_FLOOR_TEST_SAVE=<a copy of GET /api/save?agent=agent> makes every read and write use that file (no station,
 * no page); snapshots, the log and FLOOR_PLAN.md then live beside it. STATION_FLOOR_TEST_STATE=<file> stands in for
 * /api/state/snapshot (a missing or broken file is an unreadable run list), STATION_FLOOR_TEST_RELOAD=reloaded|busy|failed
 * for the page reload, STATION_FLOOR_TEST_REVERT=1 makes the reloaded "page" save its stale floor back over the write,
 * STATION_FLOOR_TEST_CONFLICTS=<n> makes the first n writes lose to "another writer". STATION_FLOOR_SNAPSHOTS,
 * STATION_FLOOR_PLAN and STATION_FLOOR_LOOPS move those files.
 * Owner of this tool: the tools seat (loops.json function `tools`); used by the floor seat (function `floor`).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const co = require('./lib/company');
const ROOT = co.ROOT;
const APP = co.p('starnet', 'frontend', 'app');
// who --by should name in the commands this tool suggests: whoever holds the floor function, at runtime
const FLOOR_BY = () => { try { return co.nameOf(co.seatFor('floor')) || '<name>'; } catch (_) { return '<name>'; } };
const ENVP = k => (process.env[k] ? path.resolve(process.env[k]) : null);
const TEST_SAVE = ENVP('STATION_FLOOR_TEST_SAVE');
const HERE = TEST_SAVE ? path.dirname(TEST_SAVE) : null;   // test mode keeps every file it writes beside the test save
const SNAPS = ENVP('STATION_FLOOR_SNAPSHOTS') || (HERE ? path.join(HERE, 'floor_snapshots') : co.p('company', 'floor_snapshots'));
const PLAN_MD = ENVP('STATION_FLOOR_PLAN') || (HERE ? path.join(HERE, 'FLOOR_PLAN.md') : co.p('company', 'FLOOR_PLAN.md'));
const LOOPS = ENVP('STATION_FLOOR_LOOPS') || co.LOOPS_FILE;
const NID_GAP = 50;   // ids an open page's own counter cannot reach before it reloads (hire.js:394-396)
const REQUIRED_CAPS = ['computer', 'cabinet', 'dish', 'notebook', 'workbench', 'studio'];   // desks + the five capability props
const CORE = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'];   // an apply may not make any of these worse
const BEGIN = '<!-- station-floor:assignments:begin -->', END = '<!-- station-floor:assignments:end -->';

/* ---------- prop floors ----------
 * A prop's spec may declare the floors it was measured to stand on: `floors` in <PROP_SPECS>/<kind>-s.json (or -n.json),
 * written by the company's own art kit if it has one. The station's own floor styles (room.floorStyle) may use a
 * different vocabulary from the art's, so <PROP_SPECS>/floor-styles.json ({ "<station style>": "<art floor>" }) is the
 * one place the two meet; with no such file a style is its own floor name.
 * The gate below refuses a place, a move or a repaint that would stand such a prop on a floor it does not declare —
 * in the dry run and in the apply, before anything is written.
 *
 * The honest limits, so nobody has to guess them:
 *  - a company with no prop specs (StarNet's own art only) is NOT gated at all;
 *  - a spec with no `floors` is NOT gated: a measurement default is not a licence the art agreed to;
 *  - a rollback (restore) is not gated: it is judged against the floor it brings back, like every other audit check.
 * PROP_SPECS: env STATION_FLOOR_PROP_SPECS, else company/brand/props.
 */
const PROP_ART = ENVP('STATION_FLOOR_PROP_SPECS') || co.p('company', 'brand', 'props');
let _FOS = null;
const FLOOR_OF_STYLE = () => _FOS || (_FOS = readJson(path.join(PROP_ART, 'floor-styles.json'), null) || {});
const SPEC_CACHE = new Map();
function propSpec(t) {   // the spec of a kind, by view; a kind with no spec (StarNet's own art) returns null
  if (SPEC_CACHE.has(t)) return SPEC_CACHE.get(t);
  let spec = null;
  for (const view of ['s', 'n']) { const f = path.join(PROP_ART, t + '-' + view + '.json'); if (fs.existsSync(f)) { spec = readJson(f, null); if (spec) break; } }
  SPEC_CACHE.set(t, spec);
  return spec;
}
const propFloors = t => { const s = propSpec(t), f = s && s.floors; return Array.isArray(f) && f.length ? f : null; };
function floorOf(v, x, y) {   // the floor a tile stands on, in the prop spec's vocabulary
  const id = v.st.roomAt(x, y); if (!id) return null;
  const rm = v.S.rooms[id]; if (!rm) return null;
  const style = rm.floorStyle || null;
  return { room: rm.name, roomId: id, style, floor: style ? FLOOR_OF_STYLE()[style] || style : null };
}
// the tiles a prop covers, as [x,y] — used so a prop half in a doorway is judged on every floor it touches
function footprint(p) { const t = []; for (let y = p.y; y < p.y + (p.h || 1); y++) for (let x = p.x; x < p.x + (p.w || 1); x++) t.push([x, y]); return t; }
function floorRefusal(p, floors, on) {
  return p.t + ' ' + p.id + ' at ' + at(p.x, p.y) + ' stands on the ' + on.style + ' floor of ' + on.room + ', which is ' +
    on.floor + ' in the art, and ' + rel(path.join(PROP_ART, p.t + '-s.json')) + ' declares floors ' + floors.join(', ') +
    '. Place it on a floor its spec declares; if the spec is wrong, change `floors` in the spec and re-measure ' +
    'the prop, so the measurement and the declaration move together.';
}
// every prop this edit places, moves, or brings under a new floor (a repaint) that would stand on an undeclared floor
function floorGate(before, after, changes) {
  const v = view(after), posed = new Map();   // prop id -> why it is being (re)posed by this edit
  for (const c of changes) {
    if (c.what === 'prop+') posed.set(c.id, 'is being placed');
    else if (c.what === 'prop' && (c.field === 'x' || c.field === 'y')) posed.set(c.id, 'is being moved');
    else if (c.what === 'room' && c.field === 'floorStyle') {   // a repaint changes the floor under everything in it
      const rm = (after.rooms || {})[c.id]; if (!rm) continue;
      for (const p of after.props || []) if (v.st.roomAt(p.x, p.y) === c.id) posed.set(p.id, 'stands in ' + rm.name + ', which this edit repaints');
    }
  }
  const blocked = [];
  for (const [id, why] of posed) {
    const p = (after.props || []).find(q => q.id === id); if (!p) continue;
    const floors = propFloors(p.t); if (!floors) continue;   // no declaration, no gate (see the note above)
    const ons = []; for (const [x, y] of footprint(p)) { const f = floorOf(v, x, y); if (f && f.floor && !ons.some(o => o.floor === f.floor && o.roomId === f.roomId)) ons.push(f); }
    for (const on of ons) if (!floors.includes(on.floor)) blocked.push('the ' + floorRefusal(p, floors, on) + ' It ' + why + '.');
  }
  return blocked;
}

const clone = o => JSON.parse(JSON.stringify(o));
// sorted-key JSON, the form the server compares floors in (station-store.js floorSnapshot)
const canon = v => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v === undefined ? null : v);
const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fb; } };
const readIf = p => { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; } };
const rel = p => path.relative(ROOT, p) || p;
const out = (code, o) => { console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 1)); process.exit(code); };
function stamp() { const d = new Date(), z = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + ' ' + z(d.getHours()) + ':' + z(d.getMinutes()); }
function writeAtomic(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + '.tmp-' + process.pid; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }
class Refusal extends Error {}   // an edit StarNet or the company rules refuse: nothing was written
const titleCase = s => String(s || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
const at = (x, y) => '(' + x + ',' + y + ')';

/* ---------- StarNet in Node ---------- */
let _C = null; const Crew = () => _C || (_C = require('./station-crew.js'));
let E = null, SB = null;
// StarNet's own modules, with the page's prop mount rules installed (app.js:3641-3644; app-modules.js does not install them)
function env(doc) {
  if (!E) {
    const M = Crew().appModules();
    if (!M.PropSprites) throw new Error('StarNet PropSprites did not load in Node (starnet/frontend/app/propsprites.js)');
    M.WorldModel.setPropRules(t => M.PropSprites.ruleFor(t));
    const req = f => require(path.join(APP, f));
    SB = req('stationbuilder.js');
    E = { WorldModel: M.WorldModel, Pipeline: req('pipeline.js'), WorkflowLine: req('workflowline.js'), PropSprites: M.PropSprites,
      RoomStyles: req('roomstyles.js'), LineEdit: req('lineedit.js'), StationTemplates: M.StationTemplates, crew: [], heroId: 'agent' };
  }
  if (doc) E.crew = [...Crew().rows(doc).values()].map(a => ({ id: String(a.id), name: a.name || String(a.id) }));
  return E;
}
const capOf = t => env().WorldModel.capForProp(t);
const isDesk = t => capOf(t) === 'computer';   // the SEAT_WORKSTATIONS types (worldmodel.js:4912) are exactly the compute props
const capLabel = c => (env().WorldModel.CAP_LABEL || {})[c] || c;

/* ---------- reads and writes: the station, or a test file ---------- */
function testIo(file) {
  let conflicts = Number(process.env.STATION_FLOOR_TEST_CONFLICTS) || 0, base = null;
  const read = () => { const r = JSON.parse(fs.readFileSync(file, 'utf8')); return r && r.save ? r : { save: r, head: { revision: Number(r && r._saveRevision) || 1 } }; };
  const write = r => writeAtomic(file, JSON.stringify(r));
  return {
    test: true,
    async getSave() { const r = read(); return { doc: r.save, revision: r.head && r.head.revision }; },
    // station-crew.editSave's contract: fn(doc) mutates; GET, mutate, write on the same revision, retry on a conflict
    async editSave(fn, label) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const { doc, revision } = await this.getSave(), was = clone(doc.station);
        if (fn(doc) === false) return null;
        const r = read(); base = was;
        if (conflicts > 0) {   // another writer (a page) saves first: the next attempt must re-plan on its floor
          conflicts--; r.save.station._nid = Number(r.save.station._nid) + 7; r.save.updatedAt = Date.now();
          r.head = Object.assign({}, r.head, { revision: (Number(r.head && r.head.revision) || 0) + 1 }); r.save._saveRevision = r.head.revision; write(r); continue;
        }
        if ((r.head && r.head.revision) !== revision) continue;
        doc.updatedAt = Date.now(); doc._saveDirty = false;
        doc._saveClient = String(label || 'floor').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40) + '-' + Date.now();
        doc._saveRevision = revision + 1;
        r.save = doc; r.head = Object.assign({}, r.head, { revision: revision + 1, client: doc._saveClient }); write(r);
        return revision + 1;
      }
      throw new Error('POST /api/save kept conflicting; is a station page open?');
    },
    // STATION_FLOOR_TEST_REVERT=1: the reloaded "page" saves its stale floor back over the write (what survival checks catch)
    async reload() { const how = process.env.STATION_FLOOR_TEST_RELOAD || 'reloaded'; if (how === 'reloaded' && process.env.STATION_FLOOR_TEST_REVERT && base) { const r = read(); r.save.station = base; r.head.revision++; write(r); } return how; },
    // a missing or broken state file is a run list that cannot be read (as a failed GET is live)
    async state() { const f = ENVP('STATION_FLOOR_TEST_STATE'); return f ? JSON.parse(fs.readFileSync(f, 'utf8')) : { runs: [] }; },
    wait: ms => new Promise(res => setTimeout(res, Math.min(ms, 50))),
  };
}
const liveIo = {
  test: false,
  getSave: () => Crew().getSave(),
  editSave: (fn, label) => Crew().editSave(fn, label),
  reload: () => Crew().reloadStationPage(),
  async state() {
    const r = await Crew().call('GET', '/api/state/snapshot');
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    return JSON.parse(r.body);
  },
  wait: ms => new Promise(res => setTimeout(res, ms)),
};
const io = TEST_SAVE ? testIo(TEST_SAVE) : liveIo;
// conversations in the owner's station tab: the runs station-crew.pageBusy() refuses a reload for (not hire.js interviews).
// A run list that cannot be read is never taken as "no conversation": it throws (exit 3, nothing written).
async function conversations() {
  let s, why = null;
  try { s = await io.state(); if (!s || !Array.isArray(s.runs)) why = 'it has no runs list'; } catch (e) { why = String(e && e.message || e).slice(0, 120); }
  if (why) {
    const e = new Refusal('the station\'s run list (GET /api/state/snapshot) could not be read (' + why + '), so it is not known whether a conversation is running in the station tab. Nothing was written; run it again in a minute.');
    e.code = 3; throw e;
  }
  return s.runs.filter(r => r && r.source === 'interactive' && !r.internal && !String(r.streamId || '').startsWith('interview-')).map(r => r.agentId || r.streamId || '?');
}

/* ---------- floor helpers ---------- */
function fixNid(S) {   // above every r/p id in use, plus the gap
  let max = 0;
  for (const id of Object.keys(S.rooms || {}).concat((S.props || []).map(p => p.id))) { const m = /^[rp](\d+)$/.exec(String(id)); if (m) max = Math.max(max, Number(m[1])); }
  S._nid = Math.max(Number(S._nid) || 0, max + 1) + NID_GAP;
  return S._nid;
}
// a desk's seat row exactly as stationbuilder.js seatRow (4033): south of it unless a desk is turned to a facing it has
function seatRow(p) {
  const S = env().PropSprites, w = p.w || 1, h = p.h || 1, rows = [], r = (p.r | 0) & 3;
  const turned = r && (p.t === 'desk' || p.t === 'desk2') && S && S.facings && S.facings(p.t).indexOf(r) >= 0;
  const side = !turned ? 0 : p.m && (r === 1 || r === 3) ? 4 - r : r;
  if (side === 0) for (let x = p.x; x < p.x + w; x++) rows.push([x, p.y + h]);
  else if (side === 2) for (let x = p.x; x < p.x + w; x++) rows.push([x, p.y - 1]);
  else if (side === 1) for (let y = p.y; y < p.y + h; y++) rows.push([p.x - 1, y]);
  else for (let y = p.y; y < p.y + h; y++) rows.push([p.x + w, y]);
  return rows;
}
const covers = (q, x, y) => x >= q.x && x < q.x + (q.w || 1) && y >= q.y && y < q.y + (q.h || 1);
function view(S) {
  const st = env().WorldModel.deserialize(S), g = st.projectGeometry(), D = st.serialize();
  return { S: D, st, g, ox: g.origin.tx, oy: g.origin.ty, name: id => ((D.rooms || {})[id] || {}).name || String(id) };
}
const solidAt = (v, x, y, except) => v.S.props.find(q => q.id !== except && q.block !== false && covers(q, x, y)) || null;
function seatOf(v, p) {
  const tiles = seatRow(p).map(([x, y]) => { const room = v.st.roomAt(x, y), by = solidAt(v, x, y, p.id);
    return { x, y, room: room || null, by: by ? by.id : null, free: !!room && !by && !!v.g.walkable(x - v.ox, y - v.oy) }; });
  return { tiles, free: tiles.filter(t => t.free).length };
}
// the walk start (stationbuilder.js spawnTile) and the rooms reachable from it (walkableRooms, not exported)
function spawnTile(v) {
  const S = v.S, rm = S.rooms[S.meta && S.meta.spawnRoomId] || S.rooms[S.order[0]], r = rm && rm.rects && rm.rects[0];
  if (!r) return null;
  const cx = (r.x1 + r.x2) >> 1, cy = (r.y1 + r.y2) >> 1; let best = null, bd = Infinity;
  for (let y = r.y1; y <= r.y2; y++) for (let x = r.x1; x <= r.x2; x++) { const d = Math.abs(x - cx) + Math.abs(y - cy); if (d < bd && v.g.walkable(x - v.ox, y - v.oy)) { bd = d; best = { x, y }; } }
  return best;
}
function roomTile(v, rm) {
  const R = rm.rects[0], cx = (R.x1 + R.x2) >> 1, cy = (R.y1 + R.y2) >> 1; let t = null, bd = Infinity;
  for (let y = R.y1; y <= R.y2; y++) for (let x = R.x1; x <= R.x2; x++) { const d = Math.abs(x - cx) + Math.abs(y - cy); if (d < bd && v.g.walkable(x - v.ox, y - v.oy)) { bd = d; t = { x, y }; } }
  return t;
}
const walk = (v, a, b) => !!(a && b && v.g.path(a.x - v.ox, a.y - v.oy, b.x - v.ox, b.y - v.oy));
function doorBetween(v, a, b) {
  for (const d of v.g.doorDefs || []) { const p = v.st.roomAt(d[0] + v.ox, d[1] + v.oy), q = v.st.roomAt(d[2] + v.ox, d[3] + v.oy); if ((p === a && q === b) || (p === b && q === a)) return true; }
  return false;
}
function roomRef(S, ref) {   // an id or a name (corridors too; StationBuilder's own room names skip corridors)
  const s = String(ref == null ? '' : ref).trim(), n = s.replace(/\s+/g, ' ').toUpperCase();
  if (S.rooms[s]) return S.rooms[s];
  const hit = Object.values(S.rooms).filter(r => String(r.name || '').replace(/\s+/g, ' ').toUpperCase() === n);
  if (hit.length === 1) return hit[0];
  throw new Refusal('there is no room "' + s + '" (rooms: ' + S.order.map(id => S.rooms[id].name + ' ' + id).join(', ') + ')');
}
function propRef(S, ref) {
  const s = String(ref == null ? '' : ref).trim(), p = S.props.find(q => q.id === s);
  if (p) return p;
  const m = /^(-?\d+)\s*,\s*(-?\d+)$/.exec(s);
  if (m) { const x = Number(m[1]), y = Number(m[2]), q = S.props.find(o => covers(o, x, y) && o.block !== false) || S.props.find(o => covers(o, x, y)); if (q) return q; }
  throw new Refusal('there is no prop "' + s + '" (use an id from `station-floor.js show`, or a tile x,y)');
}
// the crew list (company/tools/loops.json). hire.js rewrites it during a hire, so a read can fail or catch it half-written:
// then { ok: false }, and A4 and every edit refuse rather than check against an empty crew.
function loadCrew() {
  let j;
  try { j = JSON.parse(fs.readFileSync(LOOPS, 'utf8')); }
  catch (e) { return { ok: false, agents: {}, why: e && e.code === 'ENOENT' ? 'the file is missing' : 'it is not valid JSON (' + String(e && e.message || e).slice(0, 80) + ')' }; }
  const ag = j && j.agents;
  if (!ag || typeof ag !== 'object' || Array.isArray(ag) || !Object.keys(ag).length) return { ok: false, agents: {}, why: 'it lists no agents' };
  return { ok: true, agents: ag };
}
function crewRows() { return loadCrew().agents; }
function needCrew() {
  const L = loadCrew(); if (L.ok) return L.agents;
  const e = new Refusal('cannot read ' + rel(LOOPS) + ' (' + L.why + '; hire.js may be writing it), so the floor tool cannot check that every crew member keeps a desk. Nothing was written; run it again in a minute.');
  e.code = 3; throw e;
}
function agentName(doc, id, o) {
  if (o && o.agentId === id && o.name) return o.name;
  const c = crewRows()[id]; if (c && c.name) return c.name;
  const r = doc ? Crew().rows(doc).get(id) : null; return r && r.name ? titleCase(r.name) : String(id);
}

/* ---------- FLOOR_PLAN.md ---------- */
function section(text, re) { const L = text.split('\n'), i = L.findIndex(l => re.test(l)); if (i < 0) return ''; let j = L.findIndex((l, k) => k > i && /^## /.test(l)); if (j < 0) j = L.length; return L.slice(i + 1, j).join('\n'); }
// section 1: "- **LOBBY** (...): **Leadership** — CEO, Hiring, Floor Manager."
function departments(text) {
  const outp = [];
  for (const l of section(text, /^## 1\./).split('\n')) {
    const m = /^- \*\*([^*]+)\*\*[^:]*:\s*\*\*([^*]+)\*\*\.?(?:\s*[—–-]\s*([^.]+))?/.exec(l);
    if (m) outp.push({ room: m[1].trim(), department: m[2].trim(), roles: [m[2].trim()].concat((m[3] || '').split(',').map(s => s.trim()).filter(Boolean)) });
  }
  return outp;
}
// section 2's table: between the markers once `doc` has run, else the first table under "## 2."
function planTable(text) {
  const lines = text.split('\n'), a = lines.findIndex(l => l.includes(BEGIN)), b = lines.findIndex(l => l.includes(END));
  let start, end;
  if (a >= 0 && b > a) { start = a + 1; end = b; }
  else { const h = lines.findIndex(l => /^## 2\.\s/.test(l)); if (h < 0) return null; start = h + 1; end = lines.findIndex((l, k) => k > h && /^## /.test(l)); if (end < 0) end = lines.length; }
  let t0 = -1; for (let i = start; i < end; i++) if (/^\|/.test(lines[i])) { t0 = i; break; }
  if (t0 < 0) return { lines, rows: [], t0: -1, t1: -1, marked: a >= 0 && b > a, a, b };
  let t1 = t0; while (t1 < end && /^\|/.test(lines[t1])) t1++;
  const cells = l => l.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(s => s.trim());
  const head = cells(lines[t0]).map(s => s.toLowerCase()), col = k => head.findIndex(h => h.startsWith(k));
  const C = { agent: col('agent'), department: col('department'), room: col('room'), xy: col('desk'), prop: col('prop'), why: col('justification') };
  const rows = lines.slice(t0 + 2, t1).map(cells).map(c => {
    const g = k => (C[k] >= 0 ? c[C[k]] || '' : '');
    return { agent: g('agent'), name: g('agent').split(/\s+[—–-]\s+/)[0].trim(), department: g('department'), room: g('room'), xy: g('xy').replace(/[`\s]/g, ''), prop: g('prop').replace(/[`\s]/g, ''), why: g('why') };
  });
  return { lines, rows, t0, t1, marked: a >= 0 && b > a, a, b };
}
function cameraRoute(text, S) {   // section 7: "The camera route is fixed**: LOBBY → CORRIDOR-3 → MEETING."
  const m = /camera route is fixed\**:\s*([^\n]+?)\.(\s|$)/i.exec(text || '');
  const names = m ? m[1].split(/\s*(?:→|->)\s*/).map(s => s.replace(/[*`]/g, '').trim()).filter(Boolean) : [];
  const ids = names.map(n => { try { return roomRef(S, n).id; } catch (_) { return null; } });
  if (names.length >= 2 && ids.every(Boolean)) return { ids, names, from: 'FLOOR_PLAN.md section 7' };
  // no route declared, or one whose names no longer resolve: check the rooms that still do (no built-in default route)
  return { ids: ids.filter(Boolean), names, from: 'FLOOR_PLAN.md section 7', stale: names.length ? names : null, none: !names.length };
}

/* ---------- the audit ---------- */
// o: { doc (save rows for A4), text (FLOOR_PLAN.md), ref (an earlier station whose capabilities must survive, for A7) }
function audit(S, o) {
  o = o || {};
  const Em = env(o.doc), WM = Em.WorldModel, v = view(S), checks = [], text = o.text == null ? readIf(PLAN_MD) : o.text;
  const add = (id, name, items) => { const f = items.some(i => !i.warn); checks.push({ id, name, status: f ? 'fail' : items.length ? 'warn' : 'pass', items }); };
  const who = p => p.agentId ? ' (' + agentName(o.doc, p.agentId) + ')' : '';
  const pname = p => p.t + ' ' + p.id + ' at ' + at(p.x, p.y) + who(p);
  // A1: every room and prop passes StarNet's own placement checks, as replaceLayout runs them (worldmodel.js:4026-4040)
  { const it = [];
    for (const id of v.S.order) { const rm = v.S.rooms[id], r = rm ? v.st.canPlaceRoom(rm.rects, rm.kind, id) : { ok: false, msg: 'missing' }; if (!r.ok) it.push({ key: 'room:' + id, msg: (rm ? rm.name : id) + ' (' + id + '): ' + (r.msg || r.error) }); }
    for (const p of v.S.props) { const r = v.st.canPlaceProp(p.t, p.x, p.y, p.w || 1, p.h || 1, p.id); if (!r.ok) it.push({ key: 'prop:' + p.id, msg: pname(p) + ': ' + (r.msg || r.error) }); }
    add('A1', 'rooms and props pass StarNet placement checks', it); }
  // A2: what the server needs to route from the saved floor (station-store.js:121-140)
  { const it = [], ids = S.props.map(p => p.id), seen = new Set();
    for (const id of ids) { if (!id || seen.has(id)) it.push({ key: 'dup:' + id, msg: 'prop id ' + id + ' is ' + (id ? 'used twice' : 'missing') }); seen.add(id); }
    const ord = S.order || [];
    if (new Set(ord).size !== ord.length) it.push({ key: 'order:dup', msg: 'a room id is listed twice in order' });
    for (const id of ord) if (!S.rooms[id] || S.rooms[id].id !== id) it.push({ key: 'order:' + id, msg: 'order names ' + id + ', which is not a room record with that id' });
    for (const id of Object.keys(S.rooms)) if (!ord.includes(id)) it.push({ key: 'orphan:' + id, msg: 'room ' + id + ' (' + S.rooms[id].name + ') is not in order, so it is invisible' });
    const was = canon(S);
    if (canon(WM.deserialize(S).serialize()) !== was) it.push({ key: 'roundtrip:rules', msg: 'the floor does not survive load and save with the page\'s prop rules (the page would rewrite it)' });
    WM.setPropRules(null);
    try { if (canon(WM.deserialize(S).serialize()) !== was) it.push({ key: 'roundtrip:server', msg: 'the floor does not survive load and save as the server reads it: its projection would be "migration-required"' }); }
    finally { WM.setPropRules(t => Em.PropSprites.ruleFor(t)); }
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const id of ord) for (const r of (S.rooms[id] || {}).rects || []) { x1 = Math.min(x1, r.x1); y1 = Math.min(y1, r.y1); x2 = Math.max(x2, r.x2); y2 = Math.max(y2, r.y2); }
    if (x2 - x1 + 1 > 240 || y2 - y1 + 1 > 240) it.push({ key: 'span', msg: 'the station spans more than 240 tiles' });
    add('A2', 'the saved floor is one the server can route from', it); }
  // A3: every bound desk has a free, walkable seat tile, counting other desks (StarNet's blockedSeats skips workstations)
  { const it = [];
    for (const p of v.S.props) {
      if (!isDesk(p.t)) continue;
      const s = seatOf(v, p); if (s.free) continue;
      const by = [...new Set(s.tiles.map(t => t.by).filter(Boolean))].map(id => v.S.props.find(q => q.id === id)).filter(Boolean);
      const msg = pname(p) + ': no free seat tile in ' + s.tiles.map(t => at(t.x, t.y)).join(' ') + (by.length ? ' (covered by ' + by.map(pname).join(', ') + ')' : ' (wall or no deck)');
      const fix = by.find(q => isDesk(q.t)) ? 'move the desk that covers it: ' + deskFix(v, by.find(q => isDesk(q.t))) : by.length ? 'move ' + by[0].id + ' off the seat row' : 'move this desk';
      it.push(p.agentId ? { key: 'seat:' + p.id, msg, fix } : { key: 'seat:' + p.id, msg: msg + ' [spare desk]', fix, warn: true });
    }
    add('A3', 'every bound desk has a free seat', it); }
  // A4: one desk for every crew member; every agentId on the floor is a crew row in the save
  { const it = [], L = loadCrew(), crew = L.agents, rows = o.doc ? Crew().rows(o.doc) : null;
    if (!L.ok) it.push({ key: 'loops:unreadable', msg: 'cannot read ' + rel(LOOPS) + ' (' + L.why + '), so one desk per crew member was not checked; run the audit again in a minute' });
    for (const id of Object.keys(crew)) {
      const n = v.S.props.filter(p => isDesk(p.t) && p.agentId === id).length;
      if (n !== 1) it.push({ key: 'desks:' + id, msg: crew[id].name + ' (' + id + ') has ' + n + ' desks; every crew member has exactly one' });
    }
    if (rows) for (const p of v.S.props) if (p.agentId && !rows.has(String(p.agentId))) it.push({ key: 'agent:' + p.id, msg: pname(p) + ' is bound to ' + p.agentId + ', who is not on the station' });
    add('A4', 'one desk per crew member, every binding a real agent', it); }
  // A5: no hallway leads nowhere; every room can be walked into from the spawn room
  { const it = [], start = spawnTile(v);
    for (const id of SB.strandedHalls(v.st)) it.push({ key: 'hall:' + id, msg: v.name(id) + ' (' + id + ') is a hallway that does not join two rooms' });
    for (const id of v.S.order) { const rm = v.S.rooms[id]; if (!rm || rm.kind === 'corridor') continue; if (!walk(v, start, roomTile(v, rm))) it.push({ key: 'walk:' + id, msg: rm.name + ' (' + id + ') cannot be walked into from ' + v.name(v.S.meta.spawnRoomId) }); }
    add('A5', 'every room is reachable', it); }
  // A6: StarNet's routing plan (the server routes from this): no blocking error; warnings listed
  { const it = [], plan = Em.Pipeline.compileRoutingPlan(v.g);
    for (const e of plan.errors || []) { const t = e.tile && isFinite(e.tile.x) ? (e.tile.x + v.ox) + ',' + (e.tile.y + v.oy) : ''; it.push({ key: e.code + ':' + (e.propId || '') + ':' + t, msg: e.code + (e.propId ? ' ' + e.propId : '') + (t ? ' at (' + t + ')' : '') + (e.msg ? ': ' + e.msg : ''), warn: !!e.warn }); }
    add('A6', 'routing compiles without new problems', it); }
  // A7: every capability the company needs (and every one the floor had before this edit) is still placed somewhere
  { const it = [], have = new Set(v.S.props.map(p => capOf(p.t)).filter(Boolean)), want = new Set(REQUIRED_CAPS);
    if (o.ref) for (const p of o.ref.props || []) { const c = capOf(p.t); if (c) want.add(c); }
    for (const c of want) if (!have.has(c)) it.push({ key: 'cap:' + c, msg: 'no ' + capLabel(c) + ' prop is left on the station (' + Object.keys(WM.CAP_PROP_MAP).filter(t => WM.CAP_PROP_MAP[t] === c).join('/') + ')' });
    add('A7', 'every capability is still on the floor', it); }
  // A8: FLOOR_PLAN.md section 2 says who sits where, as the save does
  { const it = [], T = text ? planTable(text) : null;
    if (!T || T.t0 < 0) it.push({ key: 'doc:missing', msg: 'no assignment table in ' + rel(PLAN_MD) + ' section 2', warn: true });
    else {
      for (const p of v.S.props.filter(q => isDesk(q.t) && q.agentId)) {
        const nm = agentName(o.doc, p.agentId), row = T.rows.find(r => r.prop === p.id), xy = p.x + ',' + p.y, room = v.name(v.st.roomAt(p.x, p.y));
        if (!row) { it.push({ key: 'doc:' + p.id, msg: nm + '\'s desk ' + p.id + ' (' + room + ' ' + xy + ') is not in the table' }); continue; }
        const bad = [row.name.toLowerCase() !== nm.toLowerCase() && 'agent ' + row.name, row.xy !== xy && 'desk ' + row.xy, row.room.toUpperCase() !== room.toUpperCase() && 'room ' + row.room].filter(Boolean);
        if (bad.length) it.push({ key: 'doc:' + p.id, msg: 'the row for ' + p.id + ' says ' + bad.join(', ') + '; the save has ' + nm + ' in ' + room + ' at ' + xy });
      }
      for (const r of T.rows) { const p = v.S.props.find(q => q.id === r.prop); if (!p || !isDesk(p.t) || !p.agentId) it.push({ key: 'doc:' + r.prop, msg: 'the row "' + r.agent + '" names ' + (r.prop || 'no prop') + ', which is ' + (p ? 'not a bound desk' : 'not on the station') }); }
    }
    add('A8', 'FLOOR_PLAN.md section 2 matches the save (fix: station-floor.js doc)', it); }
  // A9: the fixed camera route still joins up (FLOOR_PLAN.md section 7)
  { const it = [], R = cameraRoute(text, v.S);
    if (R.stale) it.push({ key: 'route:names', msg: 'FLOOR_PLAN.md section 7 names the route ' + R.stale.join(' → ') + ', which no longer matches the room names; checked ' + R.ids.map(v.name).join(' → '), warn: true });
    if (R.none) it.push({ key: 'route:none', msg: 'FLOOR_PLAN.md section 7 declares no camera route, so there is none to check', warn: true });
    else if (R.ids.length < 2) it.push({ key: 'route:rooms', msg: 'the camera route rooms are gone' });
    for (let i = 0; i + 1 < R.ids.length; i++) if (!doorBetween(v, R.ids[i], R.ids[i + 1])) it.push({ key: 'route:' + R.ids[i] + '-' + R.ids[i + 1], msg: v.name(R.ids[i]) + ' and ' + v.name(R.ids[i + 1]) + ' no longer open onto each other' });
    if (R.ids.length >= 2) { const a = v.S.rooms[R.ids[0]], b = v.S.rooms[R.ids[R.ids.length - 1]]; if (a && b && !walk(v, roomTile(v, a), roomTile(v, b))) it.push({ key: 'route:walk', msg: 'nobody can walk from ' + a.name + ' to ' + b.name }); }
    add('A9', 'the camera route ' + R.ids.map(v.name).join(' → ') + ' is connected', it); }
  // A10: decor density — the floor must not quietly go bare again (one decor piece per 15 tiles in a work room,
  // one per 12 in a room that goes on camera). The list counts StarNet catalog furnishing of every kind a room's work
  // might need (racks and shelves for a server room, a safe for finance, a camera rig for a studio), so a thin room can
  // be greened with fittings for its purpose instead of unrelated furniture. No capability prop is on the list.
  { const it = [], R = cameraRoute(text, v.S);
    const DECOR = new Set(['rack', 'shelf', 'crate', 'boxes', 'camerarig', 'camerarig_r', 'arc_floorlight',
      'arc_microfiche', 'safe', 'vault', 'treasury_coinsorter', 'treasury_pnl_holo', 'treasury_token_furnace',
      'industrial_drawerbank', 'console', 'cablerun', 'industrial_toolcaddy', 'industrial_supplycart', 'industrial_cabletray',
      'industrial_locker', 'industrial_servicecab', 'research_papers', 'research_corelens',
      'plant', 'tallplant', 'monstera', 'terrarium', 'industrial_planter', 'bookshelf',
      'bookstack', 'mug', 'radio', 'guitar', 'easel', 'fishtank', 'jukebox', 'speaker', 'tv', 'screens',
      'holotable', 'bigscreen', 'whiteboard', 'calwall', 'chartwall', 'ticker', 'missionboard', 'trophycase',
      'lavalamp', 'rug', 'rug_small', 'rug_large', 'couch', 'stool', 'chair', 'sidetable', 'lowtable',
      'glasstable', 'dinertable', 'booth', 'dinerchair', 'podchair', 'loungetable', 'longtable', 'beanbag',
      'coffee', 'bar', 'counter', 'desklamp', 'toolbox', 'figurine', 'deskterminal', 'pokertable', 'pinball']);
    const CAMERA = new Set(R.ids);   // the rooms on FLOOR_PLAN.md section 7's camera route
    for (const id of v.S.order) {
      const rm = v.S.rooms[id]; if (!rm) continue;
      const onCamera = CAMERA.has(id);
      if (rm.kind === 'corridor' && !onCamera) continue;      // a hallway is a hallway, unless it goes on camera
      const tiles = rm.rects.reduce((n, rc) => n + (rc.x2 - rc.x1 + 1) * (rc.y2 - rc.y1 + 1), 0);
      const want = Math.ceil(tiles / (onCamera ? 12 : 15));
      const have = v.S.props.filter(p => DECOR.has(p.t) && v.st.roomAt(p.x, p.y) === id).length;
      if (have < want) it.push({ key: 'decor:' + id, warn: true,
        msg: rm.name + ' has ' + have + ' decor piece' + (have === 1 ? '' : 's') + ' for ' + tiles + ' tiles; the standard is ' + want + (onCamera ? ' (camera room)' : ' (work room)') });
    }
    add('A10', 'every work room carries its share of decor', it); }
  // A11: a prop whose art spec declares its floors stands on one of them. This is the
  // standing-state twin of the placement gate: the gate stops a bad placement being written, A11 reports the ones
  // already on the floor. It warns and never fails, because a warn is what a check that an apply may not worsen
  // should be for state the station inherited; the gate is what refuses.
  { const it = [];
    for (const p of v.S.props) {
      const floors = propFloors(p.t); if (!floors) continue;
      const ons = []; for (const [x, y] of footprint(p)) { const f = floorOf(v, x, y); if (f && f.floor && !ons.some(o => o.floor === f.floor && o.roomId === f.roomId)) ons.push(f); }
      for (const on of ons) if (!floors.includes(on.floor))
        it.push({ key: 'floor:' + p.id + ':' + on.floor, warn: true, msg: pname(p) + ' declares floors ' + floors.join(', ') + ' and stands on the ' + on.style + ' floor of ' + on.room + ' (' + on.floor + ')' });
    }
    add('A11', 'a prop whose spec declares its floors stands on one of them', it); }
  return { checks, failed: checks.filter(c => c.status === 'fail').map(c => c.id), warned: checks.filter(c => c.status === 'warn').map(c => c.id) };
}
// fail keys per check (A6: warnings count too, so a new routing warning is "worse")
const keysOf = (A, id) => new Set(((A.checks.find(c => c.id === id) || {}).items || []).filter(i => !i.warn || id === 'A6').map(i => i.key));
function compareAudits(A0, A1) {
  const worse = [], better = [];
  for (const c of A1.checks) {
    const k0 = keysOf(A0, c.id), k1 = keysOf(A1, c.id);
    for (const i of c.items) if ((!i.warn || c.id === 'A6') && !k0.has(i.key)) worse.push(c.id + ' ' + i.msg);
    for (const i of (A0.checks.find(x => x.id === c.id) || { items: [] }).items) if ((!i.warn || c.id === 'A6') && !k1.has(i.key)) better.push(c.id + ' ' + i.msg);
  }
  return { worse, better };
}
const brief = A => Object.fromEntries(A.checks.map(c => [c.id, c.status]));

/* ---------- one desk: hire.js and the A3 fixes ---------- */
// a w x h spot in roomId where this desk fits StarNet's checks, its own seat row has a free tile, and it stands on nobody's
// seat nor in a doorway lane (3 tiles in from each door, as stationbuilder.js nearestFree keeps them); nearest to where it is
function deskSpot(v, desk, roomId) {
  const rm = v.S.rooms[roomId]; if (!rm) return null;
  const w = desk.w || 2, h = desk.h || 1, others = v.S.props.filter(q => q.id !== desk.id && isDesk(q.t));
  const keep = new Set(); for (const q of others) for (const [x, y] of seatRow(q)) keep.add(x + ',' + y);
  for (const d of v.g.doorDefs || []) {
    const A = [d[0] + v.ox, d[1] + v.oy], B = [d[2] + v.ox, d[3] + v.oy];
    for (const [c, o] of [[A, B], [B, A]]) if (v.st.roomAt(c[0], c[1]) === roomId) for (let k = 0; k < 3; k++) keep.add((c[0] + (c[0] - o[0]) * k) + ',' + (c[1] + (c[1] - o[1]) * k));
  }
  const home = v.st.roomAt(desk.x, desk.y) === roomId, cands = [];
  for (const R of rm.rects) for (let y = R.y1; y <= R.y2; y++) for (let x = R.x1; x <= R.x2; x++) cands.push([x, y, home ? Math.abs(x - desk.x) + Math.abs(y - desk.y) : (y === R.y1 ? 1e6 : 0) + y * 1000 + x]);
  cands.sort((p, q) => p[2] - q[2] || p[1] - q[1] || p[0] - q[0]);
  for (const [x, y] of cands) {
    let ok = !(x === desk.x && y === desk.y);
    for (let yy = y; yy < y + h && ok; yy++) for (let xx = x; xx < x + w; xx++) if (v.st.roomAt(xx, yy) !== roomId || keep.has(xx + ',' + yy)) { ok = false; break; }
    if (!ok || !v.st.canPlaceProp(desk.t, x, y, w, h, desk.id).ok) continue;
    const free = seatRow(Object.assign({}, desk, { x, y })).some(([sx, sy]) => v.st.roomAt(sx, sy) === roomId && !keep.has(sx + ',' + sy) && !v.S.props.some(q => q.id !== desk.id && q.block !== false && covers(q, sx, sy)));
    if (free) return { x, y, roomId, room: rm.name };
  }
  return null;
}
function deskFix(v, desk) {
  const s = deskSpot(v, desk, v.st.roomAt(desk.x, desk.y));
  return s ? '`node company/tools/station-floor.js move ' + desk.id + ' ' + s.x + ' ' + s.y + ' --by ' + FLOOR_BY() + '` (a free spot in ' + s.room + '; check it with --dry)' : 'no free spot in its room; plan a move with station-floor.js plan';
}
// the room FLOOR_PLAN.md puts this person in: their section 2 row (once its Department is filled in; `doc` writes "—" for
// a desk nobody has placed yet), else a section 1 role their title names (else unknown)
const decided = d => !!String(d || '').trim() && !/^[—–-]+$/.test(String(d).trim());
function departmentRoom(text, S, name, title) {
  const T = text ? planTable(text) : null, row = T && T.rows.find(r => r.name && name && r.name.toLowerCase() === String(name).toLowerCase() && decided(r.department));
  const byName = n => { try { return roomRef(S, n); } catch (_) { return null; } };
  if (row && byName(row.room)) return { room: byName(row.room).id, name: byName(row.room).name, department: row.department, from: 'FLOOR_PLAN.md section 2' };
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hits = departments(text).filter(d => title && d.roles.some(r => new RegExp('(^|[^A-Za-z])' + esc(r) + '([^A-Za-z]|$)', 'i').test(String(title))) && byName(d.room));
  const rooms = [...new Set(hits.map(d => byName(d.room).id))];
  if (rooms.length === 1) return { room: rooms[0], name: S.rooms[rooms[0]].name, department: hits[0].department, from: 'FLOOR_PLAN.md section 1 (title "' + title + '")' };
  return { room: null, name: null, department: null, from: rooms.length > 1 ? 'ambiguous: the title matches ' + rooms.map(id => S.rooms[id].name).join(', ') : 'not recorded' };
}
// A3/A4 for one agent's desk, plus whether it stands in their department's room. st: a WorldModel station (or a station doc).
function checkDesk(st, agentId, o) {
  o = o || {};
  const S = st && typeof st.serialize === 'function' ? st.serialize() : st, v = view(S), aid = String(agentId || ''), problems = [];
  const name = o.name || agentName(null, aid, { agentId: aid, name: o.name }), crew = crewRows()[aid] || {}, title = o.title || crew.title || '';
  const desks = v.S.props.filter(p => isDesk(p.t) && p.agentId === aid), desk = desks[0] || null;
  if (o.rows && !(o.rows.has ? o.rows.has(aid) : o.rows[aid])) problems.push({ code: 'NOT_IN_SAVE', msg: aid + ' is not an agent row in the station save.' });
  if (!desk) problems.push({ code: 'NO_DESK', msg: name + ' (' + aid + ') has no desk on the floor.' });
  if (desks.length > 1) problems.push({ code: 'MANY_DESKS', msg: name + ' has ' + desks.length + ' desks (' + desks.map(p => p.id).join(', ') + '); the page seats them only at the first.' });
  let seat = null, department = null, suggest = null, roomId = null;
  if (desk) {
    roomId = v.st.roomAt(desk.x, desk.y);
    const placed = v.st.canPlaceProp(desk.t, desk.x, desk.y, desk.w || 1, desk.h || 1, desk.id);
    if (!placed.ok) problems.push({ code: 'BAD_PLACE', msg: 'desk ' + desk.id + ' at ' + at(desk.x, desk.y) + ' fails StarNet\'s placement check: ' + (placed.msg || placed.error) + '.' });
    seat = seatOf(v, desk);
    if (!seat.free) problems.push({ code: 'SEAT_BLOCKED', msg: name + '\'s desk ' + desk.id + ' at ' + at(desk.x, desk.y) + ' has no free seat tile (' + seat.tiles.map(t => at(t.x, t.y) + (t.by ? ' under ' + t.by : t.room ? '' : ' off the deck')).join(', ') + ').' });
    for (const q of v.S.props) {   // this desk standing on a neighbour's seat (a desk turned or slid onto the next desk's seat row)
      if (q.id === desk.id || !isDesk(q.t) || !q.agentId) continue;
      const row = seatRow(q); if (!row.some(([x, y]) => covers(desk, x, y))) continue;
      if (!seatOf(v, q).free) problems.push({ code: 'BLOCKS_SEAT', msg: 'desk ' + desk.id + ' covers the whole seat row of ' + agentName(null, q.agentId) + '\'s desk ' + q.id + ' at ' + at(q.x, q.y) + '.' });
    }
    department = departmentRoom(o.text == null ? readIf(PLAN_MD) : o.text, v.S, name, title);
    if (!department.room) problems.push({ code: 'NO_DEPARTMENT', msg: 'FLOOR_PLAN.md does not say which room ' + name + (title ? ' (' + title + ')' : '') + ' belongs in (' + department.from + '); the desk is in ' + v.name(roomId) + ', where hire.js seats every new hire.' });
    else if (department.room !== roomId) problems.push({ code: 'WRONG_ROOM', msg: name + '\'s desk is in ' + v.name(roomId) + '; ' + department.from + ' puts ' + name + ' in ' + department.name + '.' });
    if (problems.some(p => p.code !== 'NO_DEPARTMENT' && p.code !== 'NOT_IN_SAVE')) {
      // a seat blocked only by another desk is fixed by moving that desk (as A3 says); anything else by moving this one
      const blocker = !problems.some(p => p.code !== 'SEAT_BLOCKED' && p.code !== 'NO_DEPARTMENT' && p.code !== 'NOT_IN_SAVE')
        ? v.S.props.find(q => isDesk(q.t) && seat.tiles.some(t => t.by === q.id)) : null;
      const which = blocker || desk, s = deskSpot(v, which, blocker ? v.st.roomAt(blocker.x, blocker.y) : (department && department.room) || roomId);
      if (s) suggest = Object.assign(s, { prop: which.id, command: 'node company/tools/station-floor.js move ' + which.id + ' ' + s.x + ' ' + s.y + ' --by ' + FLOOR_BY() });
    }
  }
  return { ok: !problems.length, agentId: aid, name, desk: desk ? { id: desk.id, t: desk.t, x: desk.x, y: desk.y, w: desk.w || 1, h: desk.h || 1, roomId, room: v.name(roomId) } : null,
    seat: seat && { free: seat.free, tiles: seat.tiles }, department, problems, suggest };
}

/* ---------- what an edit changes ---------- */
function diffStation(a, b) {
  const ch = [], ra = a.rooms || {}, rb = b.rooms || {};
  for (const id of Object.keys(rb)) if (!ra[id]) ch.push({ what: 'room+', id, to: rb[id] });
  for (const id of Object.keys(ra)) if (!rb[id]) ch.push({ what: 'room-', id, from: ra[id] });
  for (const id of Object.keys(ra)) if (rb[id]) for (const k of new Set(Object.keys(ra[id]).concat(Object.keys(rb[id])))) if (canon(ra[id][k]) !== canon(rb[id][k])) ch.push({ what: 'room', id, field: k, from: ra[id][k], to: rb[id][k] });
  const pa = new Map((a.props || []).map(p => [p.id, p])), pb = new Map((b.props || []).map(p => [p.id, p]));
  for (const [id, p] of pb) if (!pa.has(id)) ch.push({ what: 'prop+', id, to: p });
  for (const [id, p] of pa) if (!pb.has(id)) ch.push({ what: 'prop-', id, from: p });
  for (const [id, p] of pa) { const q = pb.get(id); if (q) for (const k of new Set(Object.keys(p).concat(Object.keys(q)))) if (canon(p[k]) !== canon(q[k])) ch.push({ what: 'prop', id, t: p.t, field: k, from: p[k], to: q[k] }); }
  if (canon(a.order) !== canon(b.order)) ch.push({ what: 'order', from: a.order, to: b.order });
  for (const k of ['belts', 'links', 'edges']) if (canon(a[k]) !== canon(b[k])) ch.push({ what: k, from: a[k], to: b[k] });
  for (const k of new Set(Object.keys(a.meta || {}).concat(Object.keys(b.meta || {})))) if (canon((a.meta || {})[k]) !== canon((b.meta || {})[k])) ch.push({ what: 'meta', field: k, from: (a.meta || {})[k], to: (b.meta || {})[k] });
  if (a._nid !== b._nid) ch.push({ what: 'nid', from: a._nid, to: b._nid });
  return ch;
}
const short = v => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s == null ? 'null' : s.length > 80 ? s.slice(0, 77) + '...' : s; };
function changeText(c, a) {
  const room = id => ((a.rooms || {})[id] || {}).name || id, rect = rs => (rs || []).map(r => r.x1 + '..' + r.x2 + ' x ' + r.y1 + '..' + r.y2).join(' + ');
  const prop = p => p.t + ' ' + p.id + ' at ' + at(p.x, p.y) + ' ' + (p.w || 1) + 'x' + (p.h || 1) + (p.agentId ? ' (' + agentName(null, p.agentId) + ')' : '');
  switch (c.what) {
    case 'room+': return '+ room ' + c.id + ' ' + c.to.name + ' (' + c.to.kind + ') ' + rect(c.to.rects);
    case 'room-': return '- room ' + c.id + ' ' + c.from.name + ' (' + c.from.kind + ') ' + rect(c.from.rects);
    case 'room': return 'room ' + c.id + ' ' + room(c.id) + ': ' + c.field + ' ' + (c.field === 'rects' ? rect(c.from) + ' -> ' + rect(c.to) : short(c.from) + ' -> ' + short(c.to));
    case 'prop+': return '+ ' + prop(c.to);
    case 'prop-': return '- ' + prop(c.from);
    case 'prop': return c.t + ' ' + c.id + ': ' + c.field + ' ' + short(c.from) + ' -> ' + short(c.to);
    case 'order': return 'room order ' + short(c.from) + ' -> ' + short(c.to);
    case 'meta': return 'station ' + c.field + ' ' + short(c.from) + ' -> ' + short(c.to);
    case 'nid': return 'id counter _nid ' + c.from + ' -> ' + c.to;
    default: return c.what + ' changed';
  }
}
// which live-safety class an edit's effect falls in (plan section 5): quiet = needs no conversation in the tab
function classify(ch, a) {
  const idle = [], structural = [], pa = new Map((a.props || []).map(p => [p.id, p])), T = c => changeText(c, a);
  for (const c of ch) {
    if (c.what === 'room+' || c.what === 'prop+' || c.what === 'prop-') structural.push(T(c));   // plan section 5: adding or removing any prop waits
    if (c.what === 'room-') { structural.push(T(c)); idle.push(T(c)); }
    if (c.what === 'room' && c.field === 'rects') idle.push(T(c));
    if (c.what === 'prop-' || c.what === 'prop+') { const p = c.from || c.to; if (isDesk(p.t) || capOf(p.t) || p.agentId) idle.push(T(c)); }
    if (c.what === 'prop') { const p = pa.get(c.id); if (isDesk(p.t) || c.field === 'agentId' || (capOf(p.t) && /^(x|y|w|h|r|m|t)$/.test(c.field))) idle.push(T(c)); }
    if (c.what === 'belts' || c.what === 'links' || c.what === 'edges') idle.push(T(c));
    if (c.what === 'order' && !ch.some(x => x.what === 'room+' || x.what === 'room-')) structural.push(T(c));
  }
  return { idle: [...new Set(idle)], structural: [...new Set(structural)] };
}
// a later read still holds every change this edit made (the page may have saved over it on its reload)
function missing(ch, now) {
  const miss = [], pn = new Map((now.props || []).map(p => [p.id, p]));
  for (const c of ch) {
    let ok = true;
    if (c.what === 'room+') ok = !!(now.rooms || {})[c.id];
    else if (c.what === 'room-') ok = !(now.rooms || {})[c.id];
    else if (c.what === 'room') ok = !!(now.rooms || {})[c.id] && canon(now.rooms[c.id][c.field]) === canon(c.to);
    else if (c.what === 'prop+') { const p = pn.get(c.id); ok = !!p && p.t === c.to.t && p.x === c.to.x && p.y === c.to.y; }
    else if (c.what === 'prop-') ok = !pn.has(c.id);
    else if (c.what === 'prop') ok = pn.has(c.id) && canon(pn.get(c.id)[c.field]) === canon(c.to);
    else if (c.what === 'meta') ok = canon((now.meta || {})[c.field]) === canon(c.to);
    else if (c.what === 'nid') ok = Number(now._nid) >= Number(c.to);
    else ok = canon(now[c.what]) === canon(c.to);
    if (!ok) miss.push(c);
  }
  return miss;
}

/* ---------- planning ---------- */
// StarNet resolves an op's "room" by id or by room name, never a corridor's name (stationbuilder.js roomRef/roomNamed):
// a corridor named there ("CORRIDOR-55") becomes its id. An `as` alias an op defines, and anything else, is left to StarNet.
function corridorIds(ops, S) {
  const aliases = new Set(ops.map(o => o && o.as).filter(x => x != null).map(String));
  return ops.map(o => {
    if (!o || typeof o.room !== 'string' || S.rooms[o.room] || aliases.has(o.room)) return o;
    let rm = null; try { rm = roomRef(S, o.room); } catch (_) {}
    return rm && rm.kind === 'corridor' ? Object.assign({}, o, { room: rm.id }) : o;
  });
}
// makeEdit(doc) -> { station, summary, notes, looseNotes, blocked: [reasons apply refuses], ops }; runs on every conflict retry
function makeRefit(ops0, allow) {
  return doc => {
    const Em = env(doc), S = doc.station, blocked = [], ops = corridorIds(ops0, S);
    fixNid(S);   // before planning: the plan's floor signature includes _nid (stationbuilder.js:69-75)
    const p = SB.planEdit(S, { refit: ops }, Em);
    if (!p || !p.ok) throw new Refusal('StarNet refused the edit: ' + ((p && p.error) || 'no reason given'));
    const notes = p.plan.notes || [];
    const looseNotes = notes.filter(n => !(allow || []).some(s => s && n.includes(s)));   // evaluate() words the refusal
    const st = Em.WorldModel.deserialize(S), r = SB.apply(st, p.plan, Em);
    if (!r || !r.ok) throw new Refusal('StarNet could not apply its own plan: ' + ((r && r.error) || 'no reason given'));
    const next = st.serialize();
    // a place on a taken tile is silently moved to the nearest free spot (stationbuilder.js:1635-1643): refuse that
    const had = new Set(S.props.map(q => q.id)), fresh = next.props.filter(q => !had.has(q.id)), used = new Set();
    for (const o of ops) {
      if (!o || String(o.op || '').toLowerCase().trim() !== 'place') continue;
      const x = Math.round(Number(o.x)), y = Math.round(Number(o.y)), hit = fresh.find(q => !used.has(q.id) && q.x === x && q.y === y);
      if (hit) { used.add(hit.id); continue; }
      const went = fresh.find(q => !used.has(q.id) && (q.t === o.t || String(q.t).replace(/_r$/, '') === String(o.t).replace(/_r$/, '')));
      blocked.push('StarNet would put the ' + o.t + ' asked for at ' + at(x, y) + ' at ' + (went ? at(went.x, went.y) : 'another tile') + ', because something stands there. Place it on a free tile.');
      if (went) used.add(went.id);
    }
    return { station: next, summary: p.plan.summary, notes, looseNotes, blocked, ops: canon(ops) !== canon(ops0) ? ops : undefined };
  };
}
function makeRestore(snap, file, dropNew) {
  return doc => {
    const Em = env(doc), cur = doc.station, S = clone(snap.station), blocked = [];
    const newRooms = Object.keys(cur.rooms).filter(id => !S.rooms[id]), newProps = cur.props.filter(p => !S.props.some(q => q.id === p.id));
    if ((newRooms.length || newProps.length) && !dropNew)
      throw new Refusal('the station has ' + [newRooms.length && newRooms.length + ' rooms (' + newRooms.join(', ') + ')', newProps.length && newProps.length + ' props (' + newProps.map(p => p.t + ' ' + p.id + (p.agentId ? ' of ' + agentName(doc, p.agentId) : '')).join(', ') + ')'].filter(Boolean).join(' and ') + ' that are not in ' + path.basename(file) + '. Restoring would remove them; add --drop-new if that is intended.');
    S._nid = Math.max(Number(cur._nid) || 0, Number(S._nid) || 0) + NID_GAP;
    const st = Em.WorldModel.deserialize(cur), r = st.replaceLayout(S);   // StarNet checks every room and prop, and keeps every agent seated
    if (!r || !r.ok) throw new Refusal('StarNet refused the snapshot layout: ' + ((r && (r.msg || r.error)) || 'no reason given'));
    // judged against the floor it brings back: a rollback may restore that floor's own known faults, never a new one
    return { station: st.serialize(), summary: 'restore the floor of ' + path.basename(file) + ' (taken ' + (snap.takenAt || '?') + ')' + (newProps.length || newRooms.length ? '; drops ' + newRooms.concat(newProps.map(p => p.id)).join(', ') : ''), notes: [], blocked, baseline: snap.station };
  };
}
// the full effect of an edit on this doc, with the company checks before and after
function evaluate(doc, makeEdit) {
  needCrew();   // A4 needs the crew list: unreadable (hire.js mid-write) means "not now", never "no crew to check"
  const before = clone(doc.station), work = clone(doc), r = makeEdit(work), after = r.station, changes = diffStation(before, after);
  const blocked = (r.blocked || []).slice();
  for (const c of changes) if (c.what === 'prop' && c.field === 't' && (capOf(c.from) || capOf(c.to))) blocked.push('it changes the type of capability prop ' + c.id + ' (' + c.from + ' -> ' + c.to + '); place a new one and remove the old instead.');
  // a prop may only stand on a floor its own spec declares; a rollback is judged against the floor it restores
  if (!r.baseline) for (const b of floorGate(before, after, changes)) blocked.push(b);
  const ctx = { doc, text: readIf(PLAN_MD) }, A0 = audit(before, ctx), A1 = audit(after, Object.assign({}, ctx, { ref: before }));
  const cmp = compareAudits(r.baseline ? audit(r.baseline, ctx) : A0, A1), cmpNow = r.baseline ? compareAudits(A0, A1) : cmp;
  const worse = cmp.worse.filter(w => CORE.includes(w.slice(0, 2)));
  // a StarNet warning: --allow-note waives the warning only, so it is offered only when the audit does not refuse the edit too
  if ((r.looseNotes || []).length) blocked.push('StarNet warns about this, and the floor tool refuses it: ' + r.looseNotes.join('; ') + '.' + (worse.length
    ? ' The floor audit refuses it as well (below), so --allow-note would not help: change the edit instead.'
    : ' If it is intended, add --allow-note "<part of that warning>".'));
  for (const w of worse) blocked.push(w.startsWith('A7') ? 'it removes the last prop of a capability: ' + w.slice(3) : 'it makes the floor audit worse: ' + w);
  return { before, after, changes, summary: r.summary, notes: r.notes || [], opsRun: r.ops, blocked, gate: classify(changes, before), audit: { before: brief(A0), after: brief(A1), worse: cmpNow.worse, better: cmpNow.better, judgedAgainst: r.baseline ? 'the snapshot being restored' : undefined }, A1 };
}
function report(ev, extra) {
  return Object.assign({ ok: !ev.blocked.length, summary: ev.summary, notes: ev.notes, refused: ev.blocked.length ? ev.blocked : undefined, opsRun: ev.opsRun,
    changes: ev.changes.map(c => changeText(c, ev.before)),
    needsQuietStation: ev.gate.idle.length || ev.gate.structural.length ? { touchesDesksCapsOrShapes: ev.gate.idle, addsOrRemoves: ev.gate.structural } : false,
    audit: ev.audit }, extra || {});
}

/* ---------- writing ---------- */
const snapName = label => new Date().toISOString().replace(/[:.]/g, '-') + '-' + (String(label || 'manual').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40) || 'manual') + '.json';
function writeSnapshot(file, station, revision, extra) { writeAtomic(file, JSON.stringify(Object.assign({ revision: revision == null ? null : revision, takenAt: new Date().toISOString(), station }, extra || {}), null, 1) + '\n'); return file; }
function logLine(line) {
  const f = path.join(SNAPS, 'log.md'); fs.mkdirSync(SNAPS, { recursive: true });
  if (!fs.existsSync(f)) fs.writeFileSync(f, '# Floor change log\n\nEvery floor change `company/tools/station-floor.js` wrote to the station, newest last. The snapshot named on each line is the floor just before that change: `node company/tools/station-floor.js restore <file> --by ' + FLOOR_BY() + '` puts it back.\n\n');
  fs.appendFileSync(f, '- ' + stamp() + ' ' + line + '\n');
}
async function applyFlow(label, makeEdit, a) {
  const by = a.by && a.by !== true ? String(a.by) : null;
  if (!by && !a.dry) throw new Refusal('--by is required (who is making this change)');
  // 1. the full effect on a fresh read; nothing is written yet
  const first = await io.getSave(), ev = evaluate(first.doc, makeEdit), real = ev.changes.filter(c => c.what !== 'nid');
  if (a.dry) return report(ev, { dryRun: true, revision: first.revision });
  if (!real.length) return { ok: true, changed: false, summary: ev.summary, note: 'nothing to change: the floor already looks like that' };
  if (ev.blocked.length) throw new Refusal(ev.blocked.join(' '));
  // 2. live safety: a conversation in the station tab means the page cannot be reloaded, so wait for it when it matters
  const quiet = !!(ev.gate.idle.length || ev.gate.structural.length);
  if (quiet) {
    // an unreadable run list counts as busy while --wait-idle lasts, and refuses (exit 3) if it is still unreadable at the end
    const probe = async () => { try { return { runs: await conversations() }; } catch (e) { return { err: e, runs: [] }; } };
    let s = await probe();
    const until = Date.now() + (Number(a['wait-idle']) || 0) * 60000;
    while ((s.err || s.runs.length) && Date.now() < until) { await io.wait(20000); s = await probe(); }
    if (s.err) throw s.err;
    const runs = s.runs;
    if (runs.length) {
      const e = new Refusal('a conversation is running in the station tab (' + runs.join(', ') + '), so the page cannot be reloaded, and this edit ' + ev.gate.idle.concat(ev.gate.structural).slice(0, 4).join('; ') + '. Nothing was written. Run it again when the conversation ends, or add --wait-idle <minutes>.');
      e.code = 3; throw e;
    }
  }
  // 3. snapshot, then write on the same revision; every conflict retry re-plans on the floor it actually read
  const snapFile = path.join(SNAPS, snapName('pre-' + label));
  writeSnapshot(snapFile, first.doc.station, first.revision, { label, by, why: a.why && a.why !== true ? String(a.why) : null });
  let done = null, rev = null;
  try { rev = await io.editSave(doc => {
    const e = evaluate(doc, makeEdit);
    if (e.blocked.length) throw new Refusal('the floor changed while this ran: ' + e.blocked.join(' '));
    if (!quiet && (e.gate.idle.length || e.gate.structural.length)) throw new Refusal('the floor changed while this ran and the edit now ' + e.gate.idle.concat(e.gate.structural).join('; ') + '; run it again.');
    // the server stores each save with _saveRevision = its revision (sidecar/savestore.js:581), so this is the revision read
    if (canon(doc.station) !== canon(first.doc.station)) writeSnapshot(snapFile, doc.station, Number(doc._saveRevision) || null, { label, by, note: 're-taken: the save changed before the write' });
    doc.station = e.after; done = e;
  }, 'floor-' + label); } catch (e) { try { fs.unlinkSync(snapFile); } catch (_) {} throw e; }   // editSave threw: nothing was written, so no snapshot for it
  if (!done || rev == null) throw new Error('the save was not written');
  // 4. read it back
  const now1 = (await io.getSave()).doc.station, change = done.changes.filter(c => c.what !== 'nid');
  const lost1 = missing(change, now1);
  // 5-6. reload the page so it shows the edit (and stops holding a stale copy), then check the edit survived its reload.
  // The run list is read first: station-crew.pageBusy() takes an unreadable one as "not busy", and a reload must never land
  // on a conversation, so an unreadable list means no reload ("unchecked").
  let page;
  try { page = (await conversations()).length ? 'busy' : await io.reload(); } catch (_) { page = 'unchecked'; }
  let survived = null, lost2 = [];
  if (page === 'reloaded') {
    for (const ms of io.test ? [0] : [8000, 15000, 20000]) { await io.wait(ms); lost2 = missing(change, (await io.getSave()).doc.station); if (!lost2.length) break; }
    survived = !lost2.length;
  }
  const res = { ok: !lost1.length && survived !== false, changed: true, summary: done.summary, revision: rev, snapshot: rel(snapFile),
    changes: done.changes.map(c => changeText(c, done.before)), readBack: lost1.length ? 'MISSING: ' + lost1.map(c => changeText(c, done.before)).join('; ') : 'the save holds every change',
    stationPage: page === 'reloaded' ? (survived ? 'reloaded; the change survived it' : 'reloaded, and it LOST: ' + lost2.map(c => changeText(c, done.before)).join('; ')) : page === 'busy' ? 'a conversation is running in the tab; the page shows the change after its next reload'
      : page === 'unchecked' ? 'not reloaded: the run list could not be read, so a conversation may be running in the tab; the page shows the change after its next reload' : 'no open station tab could be reloaded (it shows the change on its next load)',
    audit: done.audit };
  if (!res.ok) res.next = 'part of the change did not hold (exit 4). Check with `station-floor.js show` and `audit`, then run the command again; `restore ' + rel(snapFile) + '` puts the floor before it back.';
  // 7. the log, then FLOOR_PLAN.md section 2
  logLine(by + ': ' + done.summary.replace(/\s+/g, ' ').replace(/^BUILD MODE, \d+ edits?, in order: /, '').replace(/ One UNDO in Build mode takes all of it back\.$/, '').slice(0, 400) + (a.why && a.why !== true ? ' Why: ' + String(a.why).slice(0, 200) + '.' : '') + ' Revision ' + first.revision + ' -> ' + rev + '; snapshot `' + path.basename(snapFile) + '`; page ' + page + (survived === false ? ' (LOST on reload)' : '') + (lost1.length ? '; READ-BACK MISSING ' + lost1.length : '') + '.');
  const renames = done.changes.filter(c => c.what === 'room' && c.field === 'name' && c.from && c.to).map(c => ({ from: String(c.from), to: String(c.to) }));
  try { const g = await io.getSave(); res.doc = writeDoc(g.doc, g.revision, { before: done.before, renames }); } catch (e) { res.doc = { ok: false, error: e.message }; }
  return res;
}

/* ---------- doc: FLOOR_PLAN.md section 2 from the save ---------- */
// a room rename carried into the two places this tool reads room names from: section 1's "- **NAME** (...)" lines (the
// departments) and section 7's camera route. All renames at once, so a swap cannot rename twice. -> { text, lines }
function syncRoomNames(text, renames) {
  const map = new Map((renames || []).map(r => [norm(r.from), r.to])), L = text.split('\n'), hit = new Set();
  if (!map.size) return { text, lines: 0 };
  const h1 = L.findIndex(l => /^## 1\./.test(l)); let e1 = h1 < 0 ? -1 : L.findIndex((l, k) => k > h1 && /^## /.test(l)); if (e1 < 0) e1 = L.length;
  for (let i = h1 + 1; h1 >= 0 && i < e1; i++) {
    const m = /^(- \*\*)([^*]+)(\*\*)/.exec(L[i]), to = m && map.get(norm(m[2]));
    if (to) { L[i] = m[1] + to + m[3] + L[i].slice(m[0].length); hit.add(i); }
  }
  for (let i = 0; i < L.length; i++) {
    const m = /(camera route is fixed\**:\s*)([^\n]+?)\.(\s|$)/i.exec(L[i]); if (!m) continue;
    const route = m[2].split(/(\s*(?:→|->)\s*)/).map((tok, k) => {
      if (k % 2) return tok;
      const core = tok.replace(/[*`]/g, '').trim(), to = map.get(norm(core));
      return to ? tok.replace(core, () => to) : tok;
    }).join('');
    if (route !== m[2]) { const at0 = m.index + m[1].length; L[i] = L[i].slice(0, at0) + route + L[i].slice(at0 + m[2].length); hit.add(i); }
  }
  return { text: L.join('\n'), lines: hit.size };
}
const norm = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toUpperCase();
// o: { before: the station before the edit (to tell a rename from a move), renames: [{ from, to }] the edit made }
function writeDoc(doc, revision, o) {
  o = o || {};
  const text0 = readIf(PLAN_MD);
  if (!text0) return { ok: false, error: 'no ' + rel(PLAN_MD) };
  const synced = syncRoomNames(text0, o.renames), text = synced.text;
  const T = planTable(text);
  if (!T || T.t0 < 0) return { ok: false, error: rel(PLAN_MD) + ' has no section 2 assignment table' };
  const v = view(doc.station), crew = crewRows(), day = stamp().slice(0, 10);
  const desks = v.S.props.filter(p => isDesk(p.t) && p.agentId), order = new Map(v.S.order.map((id, i) => [id, i]));
  const rowOf = p => T.rows.find(r => r.prop === p.id && r.name.toLowerCase() === agentName(doc, p.agentId).toLowerCase()) || T.rows.find(r => r.name.toLowerCase() === agentName(doc, p.agentId).toLowerCase());
  const rank = p => { const r = rowOf(p), i = r ? T.rows.indexOf(r) : -1; return i >= 0 ? i : 1000 + (order.get(v.st.roomAt(p.x, p.y)) || 0) * 1000 + p.y * 100 + p.x; };
  const cell = s => String(s == null ? '' : s).replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  // the room a row's Room cell names: on the floor before the edit when known (a renamed room keeps its id), else today's
  const roomOfRow = name => { for (const S of [o.before, v.S]) { if (!S) continue; try { return roomRef(S, name).id; } catch (_) {} } return null; };
  const rows = desks.slice().sort((p, q) => rank(p) - rank(q)).map(p => {
    const roomId = v.st.roomAt(p.x, p.y), room = v.name(roomId), r = rowOf(p), nm = agentName(doc, p.agentId), xy = p.x + ',' + p.y;
    // a new row's Department: the section 1 department the title names, else "—" (the floor owner decides; never guessed from the
    // room hire.js happened to put the desk in)
    const dept = r && r.department ? r.department : (departmentRoom(text, v.S, nm, crew[p.agentId] && crew[p.agentId].title).department || '—');
    // the same seat: the desk did not move, or it moved inside the room the row names (a renamed room is not a move)
    const same = !!r && (r.xy === xy || roomOfRow(r.room) === roomId);
    const was = r && r.why ? r.why.replace(/^(Moved from [^;]*; justification to be rewritten\. Was: )+/, '') : '';
    const why = r && r.why && same ? r.why : was ? 'Moved from ' + r.room + ' ' + r.xy + ' on ' + day + '; justification to be rewritten. Was: ' + was : 'Desk ' + p.id + ' placed before ' + day + '; justification to be written by ' + FLOOR_BY() + '.';
    const agent = r && r.agent ? r.agent : nm + (crew[p.agentId] && crew[p.agentId].title ? ' — ' + crew[p.agentId].title : '');
    return '| ' + [agent, dept, room, xy, p.id, why].map(cell).join(' | ') + ' |';
  });
  const table = [T.lines[T.t0], T.lines[T.t0 + 1]].concat(rows);
  const res = { ok: true, file: rel(PLAN_MD), rows: rows.length };
  if (synced.lines) {
    res.renamed = synced.lines + ' line(s) of sections 1 and 7 now use the new room name(s)';
    const left = (o.renames || []).map(r => [r.from, (text.match(new RegExp('(^|[^A-Za-z0-9-])' + r.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9-])', 'g')) || []).length]).filter(x => x[1]);
    if (left.length) res.note = 'FLOOR_PLAN.md still says ' + left.map(x => x[0] + ' ' + x[1] + ' time(s)').join(', ') + ' in prose and history; change those by hand where they describe the floor as it is now.';
  }
  if (table.join('\n') === T.lines.slice(T.t0, T.t1).join('\n') && !synced.lines) return Object.assign(res, { changed: false });
  const note = '_Table generated from the live save by `node company/tools/station-floor.js doc` (save revision ' + (revision == null ? '?' : revision) + ', ' + stamp() + '). Department and Justification are kept from the rows already here; edit them freely._';
  const L = T.lines.slice();
  if (table.join('\n') !== T.lines.slice(T.t0, T.t1).join('\n')) {
    if (T.marked) L.splice(T.a + 1, T.b - T.a - 1, note, '', ...table);
    else L.splice(T.t0, T.t1 - T.t0, BEGIN, note, '', ...table, END);
  }
  writeAtomic(PLAN_MD, L.join('\n'));
  return Object.assign(res, { changed: true });
}

/* ---------- commands ---------- */
function show(doc, revision, a) {
  const v = view(doc.station), S = v.S, only = a.room && a.room !== true ? roomRef(S, a.room).id : null;
  const rooms = S.order.filter(id => !only || id === only).map(id => {
    const rm = S.rooms[id], props = S.props.filter(p => v.st.roomAt(p.x, p.y) === id).map(p => {
      const o = { id: p.id, t: p.t, x: p.x, y: p.y, w: p.w || 1, h: p.h || 1 };
      if (p.agentId) { o.agentId = p.agentId; o.agent = agentName(doc, p.agentId); }
      if (capOf(p.t)) o.grants = capLabel(capOf(p.t));
      if (p.block === false) o.walkThrough = true;
      if (p.r) o.r = p.r; if (p.m) o.m = p.m; if (p.label) o.label = p.label;
      { const f = propFloors(p.t); if (f) o.floors = f; }   // the floors its art spec declares
      if (isDesk(p.t)) { const s = seatOf(v, p); o.seat = s.tiles.map(t => at(t.x, t.y) + (t.free ? '' : t.by ? ' under ' + t.by : ' blocked')).join(' '); o.seatFree = s.free; }
      return o;
    });
    return { id, name: rm.name, kind: rm.kind, rects: rm.rects, floor: { style: rm.floorStyle || null, mat: v.st.matOfRoom(id) }, walls: { style: v.st.wallStyleOfRoom(id) || null, mat: v.st.wallMatOfRoom(id) },
      exterior: { style: v.st.hullStyleOfRoom(id) || null, mat: v.st.hullMatOfRoom(id) }, paintedTiles: Object.keys(rm.floorPaint || {}).length, props };
  });
  const off = only ? [] : S.props.filter(p => !v.st.roomAt(p.x, p.y)).map(p => ({ id: p.id, t: p.t, x: p.x, y: p.y }));
  if (a.json) return { ok: true, revision, station: S.meta && S.meta.name, nid: S._nid, rooms, offDeck: off };
  const L = [(S.meta && S.meta.name || 'station') + ': save revision ' + revision + ', ' + S.order.length + ' rooms, ' + S.props.length + ' props, _nid ' + S._nid];
  for (const r of rooms) {
    L.push('', r.id + ' ' + r.name + ' (' + r.kind + ') ' + r.rects.map(q => 'x ' + q.x1 + '..' + q.x2 + ', y ' + q.y1 + '..' + q.y2).join(' + ') +
      ' | floor ' + (r.floor.style || 'default') + '/' + r.floor.mat + ' | walls ' + (r.walls.style || 'floor hue') + '/' + r.walls.mat + ' | exterior ' + (r.exterior.style || 'own tone') + '/' + r.exterior.mat + (r.paintedTiles ? ' | ' + r.paintedTiles + ' painted tiles' : ''));
    for (const p of r.props) L.push('  ' + p.id + ' ' + p.t + ' ' + at(p.x, p.y) + ' ' + p.w + 'x' + p.h + (p.grants ? ' grants ' + p.grants : '') + (p.agent ? ' — ' + p.agent + ' [' + p.agentId + ']' : '') + (p.seat ? ' seat ' + p.seat + (p.seatFree ? '' : '  NO FREE SEAT') : '') + (p.walkThrough ? ' (walk-through)' : '') + (p.floors ? ' floors ' + p.floors.join(',') : ''));
  }
  if (off.length) L.push('', 'off the deck: ' + off.map(p => p.id + ' ' + p.t + ' ' + at(p.x, p.y)).join(', '));
  return L.join('\n');
}
function readOps(a, k) {
  let raw = a.ops && a.ops !== true ? String(a.ops) : null;
  if (!raw && a.pos[k]) { const f = path.resolve(String(a.pos[k])); if (!fs.existsSync(f)) throw new Refusal('no ops file ' + a.pos[k]); raw = fs.readFileSync(f, 'utf8'); }
  if (!raw) throw new Refusal('give the edits: --ops \'[{"op":"rename","room":"MEETING","name":"BRIEFING"}]\' or a JSON file');
  let ops; try { ops = JSON.parse(raw); } catch (e) { throw new Refusal('the ops are not JSON: ' + e.message); }
  if (ops && !Array.isArray(ops) && Array.isArray(ops.refit)) ops = ops.refit;
  if (!Array.isArray(ops) || !ops.length || ops.some(o => !o || typeof o !== 'object' || typeof o.op !== 'string')) throw new Refusal('the ops must be a list of StarNet refit edits, each { "op": ... }');
  return ops;
}
const N = (v, what) => { const n = Number(v); if (v === undefined || v === true || !Number.isInteger(n)) throw new Refusal(what + ' must be a whole number of tiles'); return n; };
// "<style>/<mat>", "<style>", or "/<mat>"; a lone word is a style when it is one, else a material
function styleMat(raw, mats, what, follow) {
  const WM = env().WorldModel, s = String(raw), styles = Object.keys(WM.FLOOR_STYLES), m = Object.keys(mats);
  let style = null, mat = null;
  if (s.includes('/')) { [style, mat] = s.split('/').map(x => x.trim() || null); }
  else if (styles.includes(s) || (follow && s === 'follow')) style = s; else mat = s;
  if (style && !styles.includes(style) && !(follow && style === 'follow')) throw new Refusal(what + ' colour "' + style + '" is not one of ' + styles.join(', ') + (follow ? ', follow' : ''));
  if (mat && !m.includes(mat)) throw new Refusal(what + ' material "' + mat + '" is not one of ' + m.join(', '));
  if (!style && !mat) throw new Refusal('--' + what + ' needs <style>/<mat>');
  const o = {}; if (style) o.style = style; if (mat) o.mat = mat; return o;
}
// the shorthands, turned into StarNet refit ops against the floor as it is now
function shorthand(cmd, a, doc) {
  const S = doc.station, p = a.pos, WM = env(doc).WorldModel;
  if (cmd === 'rename') { const rm = roomRef(S, p[1]); const name = p.slice(2).join(' ').trim(); if (!name) throw new Refusal('usage: rename <room> <NEW NAME>'); return [{ op: 'rename', room: rm.id, name }]; }
  if (cmd === 'paint') {
    const rm = roomRef(S, p[1]), ops = [];
    if (a.floor) ops.push(Object.assign({ op: 'floor', room: rm.id }, styleMat(a.floor, WM.FLOOR_MATERIALS, 'floor', false)));
    if (a.walls) ops.push(Object.assign({ op: 'walls', room: rm.id }, styleMat(a.walls, WM.WALL_MATERIALS, 'walls', true)));
    if (a.hull) ops.push(Object.assign({ op: 'hull', room: rm.id }, styleMat(a.hull, WM.HULL_MATERIALS, 'hull', true)));
    if (!ops.length) throw new Refusal('usage: paint <room> [--floor <style>/<mat>] [--walls <style|follow>/<mat>] [--hull <style|follow>/<mat>]');
    return ops;
  }
  if (cmd === 'move') return [{ op: 'move', prop: propRef(S, p[1]).id, x: N(p[2], 'x'), y: N(p[3], 'y') }];
  if (cmd === 'place') { if (!p[1]) throw new Refusal('usage: place <type> <x> <y> [--r 0-3]'); const o = { op: 'place', t: String(p[1]), x: N(p[2], 'x'), y: N(p[3], 'y') }; if (a.r !== undefined && a.r !== true) o.r = N(a.r, 'r'); return [o]; }
  if (cmd === 'remove') return [{ op: 'delete', prop: propRef(S, p[1]).id }];
  if (cmd === 'seat') {
    const d = propRef(S, p[1]); if (!isDesk(d.t)) throw new Refusal(d.id + ' is a ' + d.t + ', not a desk');
    const want = String(p[2] || ''); if (!want) throw new Refusal('usage: seat <desk> <agentId|nobody>');
    if (/^(nobody|none)$/i.test(want)) return [{ op: 'agent', prop: d.id, agent: 'nobody' }];
    const rows = [...Crew().rows(doc).values()], hit = rows.filter(r => String(r.id) === want || String(r.name || '').toLowerCase() === want.toLowerCase());
    if (hit.length !== 1) throw new Refusal('no single agent "' + want + '" on the station (ids: ' + rows.map(r => r.id).join(', ') + ')');
    return [{ op: 'agent', prop: d.id, agent: String(hit[0].id) }];
  }
  if (cmd === 'room') {
    const sub = p[1];
    if (sub === 'add') { const o = { op: 'room', name: String(p[2] || ''), x: N(p[3], 'x'), y: N(p[4], 'y'), w: N(p[5], 'w'), h: N(p[6], 'h') }; if (!o.name) throw new Refusal('usage: room add <NAME> <x> <y> <w> <h> [--kind hab]'); if (a.kind && a.kind !== true) o.kind = String(a.kind); return [o]; }
    if (sub === 'resize') return [{ op: 'resize', room: roomRef(S, p[2]).id, x: N(p[3], 'x'), y: N(p[4], 'y'), w: N(p[5], 'w'), h: N(p[6], 'h') }];
    if (sub === 'move') return [{ op: 'move', room: roomRef(S, p[2]).id, x: N(p[3], 'x'), y: N(p[4], 'y') }];
    if (sub === 'kind') return [{ op: 'type', room: roomRef(S, p[2]).id, kind: String(p[3] || '') }];
    if (sub === 'remove') { const rm = roomRef(S, p[2]); return [rm.kind === 'corridor' ? { op: 'delete', hall: rm.id } : { op: 'delete', room: rm.id }]; }
    throw new Refusal('usage: room add|resize|move|kind|remove ...');
  }
  if (cmd === 'hall') {
    if (p[1] === 'add') return [{ op: 'hall', x: N(p[2], 'x'), y: N(p[3], 'y'), w: N(p[4], 'w'), h: N(p[5], 'h') }];
    if (p[1] === 'remove') { const rm = roomRef(S, p[2]); if (rm.kind !== 'corridor') throw new Refusal(rm.name + ' is a room, not a hallway (use room remove)'); return [{ op: 'delete', hall: rm.id }]; }
    throw new Refusal('usage: hall add <x> <y> <w> <h> | hall remove <hall>');
  }
  return null;
}
function args(argv) {
  const BOOL = new Set(['dry', 'json', 'strict', 'drop-new']), o = { pos: [] };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (!s.startsWith('--')) { o.pos.push(s); continue; }
    const k = s.slice(2); let v = true;
    if (!BOOL.has(k) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) v = argv[++i];
    if (k === 'allow-note') (o[k] = o[k] || []).push(String(v)); else o[k] = v;
  }
  return o;
}
async function main() {
  const a = args(process.argv.slice(2)), cmd = a.pos[0];
  const allow = a['allow-note'] || [];
  if (cmd === 'show') { const { doc, revision } = await io.getSave(); const r = show(doc, revision, a); out(0, r); }
  if (cmd === 'audit') {
    const { doc, revision } = await io.getSave(); const A = audit(doc.station, { doc, text: readIf(PLAN_MD) });
    const bad = A.checks.filter(c => c.status === 'fail' || (a.strict && c.status === 'warn'));
    out(bad.length ? 1 : 0, { ok: !bad.length, revision, strict: !!a.strict, failed: A.failed, warned: A.warned,
      checks: A.checks.map(c => ({ id: c.id, check: c.name, status: c.status, items: c.items.length ? c.items.map(i => (i.warn ? 'warning: ' : '') + i.msg + (i.fix ? ' Fix: ' + i.fix : '')) : undefined })) });
  }
  if (cmd === 'snapshot') {
    const { doc, revision } = await io.getSave(), f = path.join(SNAPS, snapName(a.label && a.label !== true ? a.label : 'manual'));
    writeSnapshot(f, doc.station, revision, { label: a.label && a.label !== true ? String(a.label) : null });
    out(0, { ok: true, file: rel(f), revision, rooms: doc.station.order.length, props: doc.station.props.length });
  }
  if (cmd === 'plan' || (cmd === 'apply' && a.dry)) { const ops = readOps(a, 1), { doc, revision } = await io.getSave(); const ev = evaluate(doc, makeRefit(ops, allow)); out(ev.blocked.length ? 2 : 0, report(ev, { dryRun: true, revision, ops })); }
  // exit 4: written, but the read-back or the page's reload lost part of it (res.ok false after a write)
  const code = r => r.ok ? 0 : a.dry ? 2 : 4;
  if (cmd === 'apply') { const r = await applyFlow('refit', makeRefit(readOps(a, 1), allow), a); out(code(r), r); }
  if (['rename', 'paint', 'move', 'place', 'remove', 'seat', 'room', 'hall'].includes(cmd)) {
    const { doc } = await io.getSave(), ops = shorthand(cmd, a, doc), label = cmd === 'room' || cmd === 'hall' ? cmd + '-' + a.pos[1] : cmd;
    const r = await applyFlow(label, makeRefit(ops, allow), a);
    out(code(r), Object.assign({ ops }, r));
  }
  if (cmd === 'restore') {
    const f = a.pos[1] ? path.resolve(String(a.pos[1])) : null, snap = f ? readJson(f, null) : null;
    if (!snap || !snap.station || snap.station.schema !== 'starnet.station') throw new Refusal('usage: restore <snapshot .json from company/floor_snapshots/> --by <name> [--drop-new]');
    const r = await applyFlow('restore', makeRestore(snap, f, !!a['drop-new']), a);
    out(code(r), r);
  }
  if (cmd === 'doc') { const { doc, revision } = await io.getSave(); const r = writeDoc(doc, revision); out(r.ok ? 0 : 1, r); }
  out(2, { ok: false, error: 'commands: show, audit, snapshot, plan, apply, rename, paint, move, place, remove, seat, room, hall, restore, doc (see the header of company/tools/station-floor.js)' });
}

module.exports = { checkDesk, audit, env, fixNid, seatRow, diffStation, planTable, departments, evaluate, makeRefit, conversations };   // evaluate, makeRefit, conversations: test seam
if (require.main === module) main().catch(e => out(e instanceof Refusal ? (e.code || 2) : 1, { ok: false, error: e.message, refused: e instanceof Refusal || undefined }));
