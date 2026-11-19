#!/usr/bin/env node
/* improve-research.js — the improvement engine's "research" generator as a read-only duty (docs/IMPROVE.md, lib/improve.js).
 *
 *   node company/tools/improve-research.js            what it would file now, in plain lines
 *   node company/tools/improve-research.js --json
 *   node company/tools/improve-research.js --duty     docs/DUTIES.md contract: exit 0 nothing due, 1 + {due, reason, key, route, items}
 * Owner: the tools function. Changes nothing, opens no socket.
 */
'use strict';
if (require.main === module) require('./lib/improve').main('research', process.argv.slice(2));
