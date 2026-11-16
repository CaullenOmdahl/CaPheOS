'use strict';
/* intake tick — run by the dispatcher every tick (company/tools/lib/modules.js runTicks) while the module is enabled.
 * Runs the feed pollers that are due (company/work/intake/pollers/*.json), then the silence watch (sources and observe
 * targets with an expected cadence that went quiet emit a `silence` event; see intake.js watch()). Not run while halted: a halted company takes nothing new in by pulling (webhooks still land; nothing acts on them). */
const fs = require('fs');
const path = require('path');
module.exports = {
  timeoutMs: 50000,
  async tick({ log, dry } = {}) {
    const say = log || (() => {});
    const co = require('../../company/tools/lib/company');
    const f = co.p('company', 'tools', 'intake.js');
    if (!fs.existsSync(f)) { say('MODULE intake: company/tools/intake.js is absent (enable the module)'); return { ok: false, skipped: 'tool absent' }; }
    const t = require(f);
    const polled = await t.poll({ dry: !!dry, log: say });
    let watched = null; try { watched = t.watch ? t.watch({ dry: !!dry, log: say }) : null; } catch (e) { say('MODULE intake: silence watch failed: ' + e.message); }
    return Object.assign({}, polled, { watch: watched && { events: watched.events } });
  },
};
