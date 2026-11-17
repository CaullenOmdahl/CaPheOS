'use strict';
// liveness console routes (owner token): Settings › System › "Test the outside alarm" (alarm-test.js).
//   GET  /api/m/liveness/alarm-test           the current or last test, the saved period and grace, the last ping
//   POST /api/m/liveness/alarm-test/start     {periodMin, graceMin}: pause the heartbeat pings only
//   POST /api/m/liveness/alarm-test/got-it    the owner saw the alert: recorded, pings resume at once
//   POST /api/m/liveness/alarm-test/resume    end it without an alert: recorded as "no alert seen", pings resume at once
const A = () => require('./alarm-test.js');
const answer = (r, ctx) => r && r.ok === false ? ctx.send(r.code === 'authority' ? 403 : r.code === 'busy' || r.code === 'idle' ? 409 : 400, r) : r;
module.exports = { routes: [
  { method: 'GET', path: 'alarm-test', auth: 'owner', handler: () => A().status() },
  { method: 'POST', path: 'alarm-test/start', auth: 'owner', handler: (req, res, ctx) => { const b = ctx.json(); return answer(A().start({ periodMin: b.periodMin, graceMin: b.graceMin, by: ctx.owner }), ctx); } },
  { method: 'POST', path: 'alarm-test/got-it', auth: 'owner', handler: async (req, res, ctx) => answer(await A().gotIt({ by: ctx.owner }), ctx) },
  { method: 'POST', path: 'alarm-test/resume', auth: 'owner', handler: async (req, res, ctx) => answer(await A().resume({ by: ctx.owner }), ctx) },
] };
