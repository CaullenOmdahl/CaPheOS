'use strict';
/* verify tick — run by the dispatcher's module hook (company/tools/lib/modules.js) for an enabled module: check every done commitment with a verify spec; pass -> verified, fail -> in_progress, judge without station -> pending-human. */
const fs = require('fs');
const path = require('path');
const tool = () => require([path.join(__dirname, '..', '..', 'company', 'tools', 'verify.js'), path.join(__dirname, 'tools', 'verify.js')].find(f => fs.existsSync(f)));
module.exports = {
  timeoutMs: 120000,
  async tick({ log, dry }) {
    const T = tool();
    const res = await T.run({ dry: !!dry });
    if (log && res.length) log('verify: ' + res.map(r => r.commitment + ' ' + r.outcome).join(', ') + (dry ? ' (dry)' : ''));
    return { checked: res.length };
  },
};
