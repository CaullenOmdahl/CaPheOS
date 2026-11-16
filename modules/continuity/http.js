'use strict';
// continuity console routes (owner): /api/m/continuity/open, /reassign, /notify — the Halt screen uses them.
const lib = require('./lib.js');
module.exports = { routes: [
  { method: 'GET', path: 'open', auth: 'owner', handler: () => Object.assign(lib.open(), { unowned: lib.unowned().map(c => c.id) }) },
  { method: 'POST', path: 'reassign', auth: 'owner', handler: (req, res, ctx) => { const b = ctx.json(); const r = lib.reassign(b.id, b.to, ctx.owner); return r.ok ? r : ctx.send(400, r); } },
  { method: 'POST', path: 'notify', auth: 'owner', handler: (req, res, ctx) => { const b = ctx.json(); const r = lib.notify(b.party, b.text, ctx.owner); return r.ok ? r : ctx.send(r.gated ? 403 : 400, r); } },
] };
