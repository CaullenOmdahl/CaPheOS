'use strict';
/* Test stub of StarNet's starnet/bin/lib/app-modules.js: just enough of the page's modules for hire.js,
 * station-crew.js and station-seed.js to run against tests/mock-station.js. Copied to <temp company>/starnet/ by
 * scripts/e2e-first-light.sh and by station-seed.js selftest. Same names and call shapes as the real modules
 * (frontend/app/worldmodel.js, dossier.js, profile.js, save.js, personas.js; the lifted app.js composer); far less inside. */
function load() {
  const PERSONAS = ['composed', 'warm', 'blunt', 'dry', 'upbeat'];
  const Personas = { exists: id => PERSONAS.includes(String(id)), DEFAULT_ID: 'composed', list: () => PERSONAS.map(id => ({ id, name: id })) };
  const identity = (name, role) => 'You are ' + name + ', an AI agent operating from a workstation aboard the STARNET station (' + (role || 'specialist') + ').';
  const composer = {
    compose(rec, o) {
      const d = rec.docs || {};
      const crew = ((o && o.crew) || []).map(x => x.name + (x.purpose ? ' (' + String(x.purpose).slice(0, 60) + ')' : '')).join(', ');
      return [d.identity, d.purpose, d.manual, d.context, crew ? 'YOUR CREW: ' + crew : '', (o && o.dossierBlock) || '',
        'APPROVAL: ' + (rec.approvalMode === 'full' ? 'full power' : 'ask first')].filter(Boolean).join('\n\n');
    },
    // app.js agentDocs: fills the four docs in place (stock identity) and returns them
    docs(a) { a.docs = a.docs || {}; const d = a.docs; if (d.identity == null) d.identity = identity(a.name, a.role); for (const k of ['purpose', 'manual', 'context']) if (d[k] == null) d[k] = ''; return d; },
    identity,
  };
  const DIM_KEYS = ['purpose', 'context'];
  const Dossier = {
    DIM_KEYS,
    fresh: () => ({ v: 1, dims: { purpose: [], context: [] }, seededFrom: {}, seedText: {}, updatedAt: 0 }),
    hydrate: x => x || {},
    seedFromDocs(dz, docs, now) { for (const k of DIM_KEYS) if (docs && String(docs[k] || '').trim()) { dz.dims[k] = [{ text: String(docs[k]).slice(0, 200), weight: 1, createdAt: now, updatedAt: now }]; dz.seedText[k] = docs[k]; } dz.updatedAt = now; return dz; },
    beliefs: (dz, k) => (dz && dz.dims && dz.dims[k]) || [],
    weightOf: b => Number(b && b.weight) || 0,
    composeBlock: dz => (dz && dz.dims && dz.dims.purpose && dz.dims.purpose.length ? 'COMMANDER DOSSIER: ' + dz.dims.purpose[0].text : ''),
  };
  const Understanding = { readiness: () => ({ ready: false, reasons: ['stub'] }) };
  const Profile = { fresh: () => ({ v: 1, tags: {}, seed: null, enabled: true, total: 0 }) };
  const Save = { envelope: state => Object.assign({ schema: 'starnet.save', version: 7, updatedAt: Date.now() }, state) };
  function makeStation(st) {
    st.props = st.props || [];
    return {
      doc: () => st,
      rooms: () => st.rooms ? Object.values(st.rooms) : [],
      ensureWorkstation(agentId) {
        let desk = st.props.find(p => p && p.agentId === agentId) || st.props.find(p => p && p.t === 'desk' && !p.agentId);
        if (!desk) { st._nid = (Number(st._nid) || 0) + 1; desk = { id: 'p' + st._nid, t: 'desk', x: st.props.length, y: 0 }; st.props.push(desk); }
        desk.agentId = agentId;
        return { ok: true, id: desk.id, agentId, roomId: 'r1' };
      },
      serialize: () => JSON.parse(JSON.stringify(st)),
    };
  }
  const WorldModel = {
    starterDoc: () => ({ schema: 'starnet.station', version: 1, _nid: 3, meta: { name: 'STARNET STATION', createdAt: Date.now(), tier: 0, spawnRoomId: 'r1', trunkRoomId: 'r1' },
      rooms: { r1: { id: 'r1', name: 'HOME', kind: 'room', rects: [{ x1: 0, y1: 0, x2: 17, y2: 10 }] } }, order: ['r1'], props: [{ id: 'p2', t: 'desk', x: 8, y: 1, w: 2, h: 1, block: true }], belts: [], edges: [], links: [] }),
    create: doc => makeStation(doc),
    deserialize: station => makeStation(JSON.parse(JSON.stringify(station || {}))),
  };
  return { Personas, composer, Dossier, Understanding, Profile, Save, WorldModel };
}
module.exports = { load };
