'use strict';
/* observe tick — run by the dispatcher every tick (company/tools/lib/modules.js runTicks) while the module is enabled.
 * Probes every watched target that is due. Not run while halted. */
const fs = require('fs');
const path = require('path');
module.exports = {
  timeoutMs: 50000,
  async tick({ log, dry } = {}) {
    const say = log || (() => {});
    const co = require('../../company/tools/lib/company');
    const f = co.p('company', 'tools', 'observe.js');
    if (!fs.existsSync(f)) { say('MODULE observe: company/tools/observe.js is absent (enable the module)'); return { ok: false, skipped: 'tool absent' }; }
    const t = require(f);
    return await t.run({ dry: !!dry, log: say });
  },
};
