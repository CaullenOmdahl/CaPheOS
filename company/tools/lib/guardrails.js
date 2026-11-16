'use strict';
/* lib/guardrails.js — helpers for the guardrail switches, shared by guardrails.js and the tools that enforce them.
 *
 *   const gr = require('./lib/guardrails');
 *   gr.NAMES                      every switch, in display order
 *   gr.guardIn(root, name)        co.guard(name) for another project root (selftests run in temp copies); the live root
 *                                 reads through co.guard itself. true = the block is ON; unknown name or unreadable
 *                                 file = ON (fail closed); 'halt' is always ON.
 *   gr.docIn(root)                the guardrails document for a root (state file, else the defaults copy)
 *   gr.isAgentCaller()            true when an agent's station run started this process
 *   gr.unguarded(name, what)      the one log/stderr phrase every tool uses when a switch let something through
 *
 * Agent detection is the merge gate's (merge-gate.js underStation(): an ancestor's argv is (…/)sidecar/index.js, or an
 * ancestor's cgroup is /<station>.service), OR'd with provenance.js underStation() (the environment pins the station puts
 * on every child). Either one saying "agent" is enough. GUARDRAILS_ASSUME_AGENT=1 can only make a caller look MORE like
 * an agent (selftests); nothing makes an agent look like the owner.
 *
 * No environment variable turns a guardrail off. Only the state file does, and only guardrails.js (owner-only) writes it.
 */
const fs = require('fs');
const path = require('path');
const co = require('./company');

const NAMES = ['ownerGates', 'spendCap', 'externalActions', 'harnessSelfEdit', 'defaultBranch', 'secrets', 'localComputer',
  'privilegedShell', 'promptInjection', 'halt'];

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const stateFile = root => path.join(path.resolve(root || co.ROOT), 'company', 'state', 'guardrails.json');
const defaultFile = root => path.join(path.resolve(root || co.ROOT), 'company', 'defaults', 'state', 'guardrails.json');
const isLive = root => !root || path.resolve(root) === path.resolve(co.ROOT);

function docIn(root) {
  const d = readJson(stateFile(root), null);
  if (d && typeof d === 'object' && d.guards) return d;
  return readJson(defaultFile(root), null) || readJson(defaultFile(co.ROOT), {}) || {};
}
function guardIn(root, name) {
  if (name === 'halt') return true;
  if (isLive(root)) return co.guard(name);
  const g = (docIn(root) || {}).guards || {};
  return g[name] !== false;
}

// ── who is calling (merge-gate.js underStation(), plus provenance.js's station environment pins) ─────────────────
const STATION_UNIT = '/' + ((co.config.station && co.config.station.serviceName) || 'capheos-station') + '.service';
function mergeGateUnderStation() {
  let pid = process.ppid;
  for (let i = 0; i < 40 && pid > 1; i++) {
    try {
      const cmd = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8');
      if (cmd.split('\0').some(a => a === 'sidecar/index.js' || a.endsWith('/sidecar/index.js'))) return true;
      try { if (fs.readFileSync('/proc/' + pid + '/cgroup', 'utf8').includes(STATION_UNIT)) return true; } catch (_) {}
      const st = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
      pid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]);
    } catch (_) { return false; }
  }
  return false;
}
function isAgentCaller() {
  if (process.env.GUARDRAILS_ASSUME_AGENT === '1') return true;
  if (mergeGateUnderStation()) return true;
  try { if (require('../provenance.js').underStation()) return true; } catch (_) {}
  return false;
}

const unguarded = (name, what) => 'UNGUARDED (guardrail ' + name + ' is OFF) allowed: ' + String(what || '').replace(/\s+/g, ' ').slice(0, 600);

module.exports = { NAMES, docIn, guardIn, stateFile, defaultFile, isAgentCaller, unguarded, STATION_UNIT };
