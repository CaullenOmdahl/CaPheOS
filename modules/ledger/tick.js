'use strict';
/* ledger tick — run by the dispatcher's module hook (company/tools/lib/modules.js) for an enabled module: refresh the revenue summary and receivables.json for the console panel; report a broken hash chain. */
const fs = require('fs');
const path = require('path');
const tool = () => require([path.join(__dirname, '..', '..', 'company', 'tools', 'ledger.js'), path.join(__dirname, 'tools', 'ledger.js')].find(f => fs.existsSync(f)));
module.exports = {
  timeoutMs: 120000,
  async tick({ log, dry }) {
    const T = tool();
    if (dry) return { dry: true };
    const s = T.summary();
    if (!s.chain && log) log('LEDGER HASH CHAIN BROKEN: node company/tools/ledger.js check');
    return { receivables: s.receivables.length, chain: s.chain };
  },
};
