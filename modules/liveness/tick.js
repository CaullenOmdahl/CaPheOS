'use strict';
/* liveness tick — run by the dispatcher every tick (company/tools/lib/modules.js), also while the company is halted:
 * write company/state/heartbeat.json and check the watcher's own heartbeat back (watch.js beat()). */
const watch = require('./watch.js');
module.exports = {
  runWhenHalted: true,
  timeoutMs: 20000,
  async tick({ log, dry, halted } = {}) {
    const r = await watch.beat({ dry, halted });
    if (r && r.stale && log) log('LIVENESS: the liveness watcher is not checking in' + (r.alerted ? ' — owner told' : ''));
    return r;
  },
};
