'use strict';
/* lib/owner.js — the one rule every owner-only command uses for "--by owner" (or the owner's name).
 *
 *   const owner = require('./lib/owner');        (or '../lib/owner' / './owner')
 *   owner.isOwnerName(by)            "owner" or company.json owner.name (case-insensitive); extra aliases via opts
 *   owner.shell()                    provenance.js ownerShell(): not under the station AND an ancestor is an interactive
 *                                    session (terminal, sshd, tmux/screen, Claude Code working for the owner) or the
 *                                    owner's console. A detached or env-stripped process is not the owner.
 *                                    The console process itself (console/server.js is this process's main script,
 *                                    not under the station) counts too: it is the owner's UI behind the owner token,
 *                                    and the tools it requires in process (approvals.js) ask this same rule.
 *   owner.refusal(by, what)          null when this process may act as the owner for `what`, else the reason
 *
 * Before this, tools disagreed: service.js / guardrails.js / cadence.js / pacer.js / money-hold.js took "not under the
 * station" as the owner (so a cron job or a detached process passed), while locked-watch.js / providers.js /
 * my-section.js required ownerShell(). Now all of them ask here. Tests inject their own answer through each tool's
 * context (or provenance.pinOwnerShell in-process); there is no environment variable that turns a process into the owner.
 */
const co = require('./company');
const prov = () => require('../provenance.js');
const ownerName = () => String((co.config && co.config.owner && co.config.owner.name) || '').trim();
function isOwnerName(by, opts) {
  const b = String(by || '').trim().toLowerCase(); if (!b) return false;
  const on = ownerName().toLowerCase();
  return b === 'owner' || (!!on && b === on) || ((opts && opts.aliases) || []).some(a => String(a).toLowerCase() === b);
}
function underStation() { try { return prov().underStation(); } catch (_) { return false; } }
// this company's own console only: a script merely named console/server.js somewhere else (a scratch copy, another
// company's checkout) is not this company's owner UI
const realOr = p => { try { return require('fs').realpathSync(p); } catch (_) { return null; } };
const OWN_CONSOLE = realOr(require('path').join(__dirname, '..', '..', '..', 'console', 'server.js'));
const isConsoleMain = () => { const m = require.main && require.main.filename; return !!m && !!OWN_CONSOLE && realOr(m) === OWN_CONSOLE; };
function shell() { try { return prov().ownerShell() || (isConsoleMain() && !underStation()); } catch (_) { return false; } }
const REASON = 'only from the owner\'s own interactive shell or the console (not an agent\'s run, and not a detached or env-stripped process)';
function refusal(by, what, opts) {
  if (!isOwnerName(by, opts)) return null;
  const ok = opts && typeof opts.shell === 'function' ? opts.shell() : shell();
  return ok ? null : '"--by ' + String(by).trim() + '" ' + (what ? 'for ' + what + ' ' : '') + 'is accepted ' + REASON;
}
module.exports = { isOwnerName, shell, underStation, refusal, ownerName, REASON, isConsoleMain };
