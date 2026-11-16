'use strict';
/* commitments tick — run by the dispatcher every tick (company/tools/lib/modules.js runTicks) while the module is enabled.
 * Wakes owners of new commitments, re-escalates unacknowledged ones (manager, then CEO), marks breaches. Runs while halted too: a halt must not hide a commitment going past due. */
const fs = require('fs');
const path = require('path');
module.exports = {
  runWhenHalted: true,
  timeoutMs: 50000,
  async tick({ log, dry } = {}) {
    const say = log || (() => {});
    const co = require('../../company/tools/lib/company');
    const f = co.p('company', 'tools', 'commitments.js');
    if (!fs.existsSync(f)) { say('MODULE commitments: company/tools/commitments.js is absent (enable the module)'); return { ok: false, skipped: 'tool absent' }; }
    const t = require(f);
    return t.tick({ dry: !!dry, log: say });
  },
};
