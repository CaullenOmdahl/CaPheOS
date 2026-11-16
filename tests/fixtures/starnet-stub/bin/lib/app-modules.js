'use strict';
/* Test stub of StarNet's starnet/bin/lib/app-modules.js: just enough of the page's modules for hire.js and
 * station-crew.js to run against tests/mock-station.js. Copied to <temp company>/starnet/ by scripts/e2e-first-light.sh. */
function load() {
  const Personas = { exists: id => ['composed', 'warm', 'blunt', 'dry', 'upbeat'].includes(String(id)) };
  const composer = {
    compose(rec, o) {
      const d = rec.docs || {};
      const crew = ((o && o.crew) || []).map(x => x.name + (x.purpose ? ' (' + String(x.purpose).slice(0, 60) + ')' : '')).join(', ');
      return [d.identity, d.purpose, d.manual, d.context, crew ? 'YOUR CREW: ' + crew : '', (o && o.dossierBlock) || ''].filter(Boolean).join('\n\n');
    },
  };
  const Dossier = { hydrate: x => x || {}, composeBlock: () => '' };
  const WorldModel = {
    deserialize(station) {
      const st = JSON.parse(JSON.stringify(station || {}));
      st.props = st.props || [];
      return {
        ensureWorkstation(agentId) {
          let desk = st.props.find(p => p && p.agentId === agentId);
          if (!desk) { st._nid = (Number(st._nid) || 0) + 1; desk = { id: 'p' + st._nid, kind: 'desk', agentId, room: 'HOME', x: st.props.length, y: 0 }; st.props.push(desk); }
          return { ok: true, roomId: 'HOME', deskId: desk.id };
        },
        serialize: () => st,
      };
    },
  };
  return { Personas, composer, Dossier, WorldModel };
}
module.exports = { load };
