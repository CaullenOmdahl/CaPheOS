'use strict';
/* scopes tick — run by the dispatcher's module hook (company/tools/lib/modules.js) for an enabled module: once a day: secret file modes, missing files, rotation due -> intake events (deduped). */
const fs = require('fs');
const path = require('path');
const tool = () => require([path.join(__dirname, '..', '..', 'company', 'tools', 'scopes.js'), path.join(__dirname, 'tools', 'scopes.js')].find(f => fs.existsSync(f)));
module.exports = {
  timeoutMs: 120000,
  async tick({ log, dry }) {
    const T = tool();
    const stamp = T.stampFile();
    const today = new Date().toISOString().slice(0, 10);
    let last = ''; try { last = fs.readFileSync(stamp, 'utf8').trim(); } catch (_) {}
    if (last === today) return { skipped: 'checked today' };
    if (dry) { log && log('scopes: would check rotation and modes'); return { dry: true }; }
    const r = T.check({});
    fs.mkdirSync(path.dirname(stamp), { recursive: true }); fs.writeFileSync(stamp, today + '\n');
    if (log && (r.findings.length || r.events.length)) log('scopes: ' + r.findings.length + ' finding(s), ' + r.events.filter(e => !e.duplicate).length + ' new rotation event(s)');
    return r;
  },
};
