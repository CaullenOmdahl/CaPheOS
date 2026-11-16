'use strict';
/* commitments for the owner console: GET /api/m/commitments/open (behind the owner token). Read-only. */
const fs = require('fs');
module.exports = {
  routes: [{
    method: 'GET', path: 'open', auth: 'owner',
    handler: () => {
      const co = require('../../company/tools/lib/company');
      const f = co.p('company', 'tools', 'commitments.js');
      if (!fs.existsSync(f)) return { ok: false, error: 'commitments is not enabled' };
      return { ok: true, commitments: require(f).list({ open: true }) };
    },
  }],
};
