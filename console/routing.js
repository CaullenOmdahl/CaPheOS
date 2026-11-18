'use strict';
/* console/routing.js — the owner's routing switches from the browser (Settings › Models › Cheaper models; docs/ROUTING.md).
 * The page says them plainly (console/ui/js/screens/settings/routing.js): "Cheaper models where quality holds" (mode),
 * "Keep routine work on lighter models" (tier caps), each Off / Watching only / On (off / shadow / live).
 * Mounted by console/server.js: require('./routing.js').mount(route, { runApi, bad, owner }).
 *
 *   GET  /api/routing                                   routing.js status --json (modes, trials with arm counts and
 *                                                       pause or hold reasons, the last 20 routing-log rows: changes
 *                                                       and holds, never the per-wake decisions)
 *   POST /api/routing/mode       { mode, why? }         routing.js mode <off|shadow|live> --by <owner>
 *   POST /api/routing/tiercaps   { mode, why? }         routing.js tiercaps <off|shadow|live> --by <owner>
 *   POST /api/routing/trials/<id>/<start|pause|resume|stop>  { why? }   routing.js trial <op> <id> --by <owner>
 *
 * Every write runs the same tool the owner would run in a shell, with --by <owner>; the tool accepts the console as the
 * owner (company/tools/lib/owner.js), checks the change and records it (provenance, decisions.md, routing-log.jsonl).
 * All of /api sits behind the console's owner sign-in and CSRF check. Nothing here reads or writes a company file.
 * Drafting a trial is the people function's work (routing.js trial create), so the console offers no create.
 */
const MODES = ['off', 'shadow', 'live'];
const TRIAL = '([a-z][a-z0-9-]{1,39})';

function mount(route, d) {
  const { runApi, bad, owner } = d;
  const whyArgs = b => {
    const why = b && b.why != null ? String(b.why).replace(/[\r\n]+/g, ' ').trim().slice(0, 300) : '';
    if (why.startsWith('-')) bad('why may not start with -');
    return why ? ['--why', why] : [];
  };
  // the owner's words for the tool's modes: Off (off), Watching only (shadow), On (live)
  const SAY = { off: 'Off', shadow: 'Watching only', live: 'On' };
  const modeArg = b => { const m = String((b && b.mode) || '').trim(); if (!MODES.includes(m)) bad('pick ' + MODES.map(x => SAY[x]).join(', ').replace(/, ([^,]*)$/, ' or $1')); return m; };
  route('GET', /^\/api\/routing$/, () => runApi('routing.js', ['status', '--json'], { timeout: 20000 }));
  route('POST', /^\/api\/routing\/mode$/, (m, q, b) => runApi('routing.js', ['mode', modeArg(b), '--by', owner()].concat(whyArgs(b)), { timeout: 30000 }));
  route('POST', /^\/api\/routing\/tiercaps$/, (m, q, b) => runApi('routing.js', ['tiercaps', modeArg(b), '--by', owner()].concat(whyArgs(b)), { timeout: 30000 }));
  route('POST', new RegExp('^/api/routing/trials/' + TRIAL + '/(start|pause|resume|stop)$'), (m, q, b) =>
    runApi('routing.js', ['trial', m[2], m[1], '--by', owner()].concat(whyArgs(b)), { timeout: 30000 }));
}
module.exports = { mount, MODES };
