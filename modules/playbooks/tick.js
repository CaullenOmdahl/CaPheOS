'use strict';
/* playbooks tick — run by the dispatcher every tick (company/tools/lib/modules.js runTicks) while the module is enabled.
 * Matches new intake events to playbooks and creates their commitments. Not run while halted (events wait behind the cursor). */
const fs = require('fs');
const path = require('path');
module.exports = {
  timeoutMs: 50000,
  async tick({ log, dry } = {}) {
    const say = log || (() => {});
    const co = require('../../company/tools/lib/company');
    const f = co.p('company', 'tools', 'playbooks.js');
    if (!fs.existsSync(f)) { say('MODULE playbooks: company/tools/playbooks.js is absent (enable the module)'); return { ok: false, skipped: 'tool absent' }; }
    const t = require(f);
    return t.run({ dry: !!dry, log: say });
  },
};
