'use strict';
/* intake webhooks, mounted by the console server at POST /hooks/intake/<source> (auth 'source': no owner token; the
 * caller proves itself with the per-source secret, see company/tools/intake.js). */
const fs = require('fs');
module.exports = {
  routes: [{
    method: 'POST', path: ':source', auth: 'source',
    handler: (req, res, ctx) => {
      const co = require('../../company/tools/lib/company');
      const f = co.p('company', 'tools', 'intake.js');
      if (!fs.existsSync(f)) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"intake is not enabled"}'); }
      return require(f).handleHook(req, res, ctx);
    },
  }],
};
