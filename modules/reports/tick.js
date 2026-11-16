'use strict';
/* reports tick — run by the dispatcher's module hook (company/tools/lib/modules.js) for an enabled module: draft the periodic reports company/work/reports/schedule.json says are due (drafting only; sending is reports.js send). */
const fs = require('fs');
const path = require('path');
const tool = () => require([path.join(__dirname, '..', '..', 'company', 'tools', 'reports.js'), path.join(__dirname, 'tools', 'reports.js')].find(f => fs.existsSync(f)));
module.exports = {
  timeoutMs: 120000,
  async tick({ log, dry }) {
    const T = tool();
    const res = T.tick({ dry: !!dry });
    if (log && res.length) log('reports: ' + res.map(r => r.party + ' ' + (r.ok === false ? 'ERROR ' + r.error : r.file)).join(', '));
    return { drafted: res.length };
  },
};
