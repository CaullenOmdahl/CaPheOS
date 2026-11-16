'use strict';
/* company.js — the one place every CaPheOS tool learns who the company is, where things live, and who holds a seat.
 *
 * Nothing in company/tools may hardcode a person's name, a company name, an owner name, a timezone, a port or an
 * absolute path. Read them from here:
 *
 *   const co = require('./lib/company');        // from company/tools/*.js
 *   co.ROOT                  project root (the folder holding company/, secrets/, starnet/, .starnet-data/)
 *   co.config                company/company.json (name, owner, timezone, station, ownerChannel)
 *   co.p('company','work')   path under ROOT
 *   co.secret('station-token')   contents of secrets/<name> (trimmed), or null; env CAPHEOS_SECRET_<NAME> wins
 *   co.stationToken()        the station API token (secrets/station-token), throws if missing
 *   co.STATION_URL           station base URL (env STARNET_URL wins)
 *   co.TZ                    the company timezone (IANA)
 *   co.crew()                loops.json .agents ({ stationId: seat })
 *   co.seatFor('people')     station id of whoever holds a function; falls back to the CEO seat
 *   co.nameOf(id)            display name of a seat holder
 *   co.ceo()                 station id of the CEO (the seat with manager null)
 *
 * Functions (loops.json seat.functions): ceo, people, tools, risk, floor, finance. A seat may hold several; the founder
 * holds all of them until the company hires. Legacy flags hr:true / toolsOwner:true are read as people / tools.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const p = (...parts) => path.join(ROOT, ...parts);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

const config = readJson(p('company', 'company.json'), {});
config.owner = config.owner || { name: 'Owner', title: 'Owner', addressAs: 'the owner' };
config.station = config.station || {};

const STATION_URL = process.env.STARNET_URL || config.station.url || 'http://127.0.0.1:' + (config.station.port || 8801);
const TZ = process.env.CAPHEOS_TZ || config.timezone || 'UTC';

const SECRETS_DIR = p('secrets');
function secret(name) {
  const env = process.env['CAPHEOS_SECRET_' + name.toUpperCase().replace(/[^A-Z0-9]/g, '_')];
  if (env) return env.trim();
  try { return fs.readFileSync(path.join(SECRETS_DIR, name), 'utf8').trim() || null; } catch (_) { return null; }
}
function stationToken() {
  const t = secret('station-token');
  if (!t) throw new Error('no station token: put it in secrets/station-token (0600) or CAPHEOS_SECRET_STATION_TOKEN');
  return t;
}

const LOOPS_FILE = p('company', 'tools', 'loops.json');
function crew() { return (readJson(LOOPS_FILE, {}) || {}).agents || {}; }

const LEGACY = { people: 'hr', tools: 'toolsOwner' };
function holds(seat, fn) {
  if (!seat) return false;
  if (Array.isArray(seat.functions) && seat.functions.includes(fn)) return true;
  return !!(LEGACY[fn] && seat[LEGACY[fn]]);
}
function ceo() {
  const c = crew();
  const byFn = Object.keys(c).find(id => holds(c[id], 'ceo'));
  if (byFn) return byFn;
  return Object.keys(c).find(id => c[id] && c[id].manager == null) || null;
}
function seatFor(fn) {
  const c = crew();
  const id = Object.keys(c).find(k => holds(c[k], fn));
  return id || ceo();
}
function nameOf(id) { const s = crew()[id]; return (s && s.name) || id; }

/* Local wall-clock pieces in the company timezone, for tools that reason about "today" or office hours. */
function localParts(date) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short' });
  const o = {}; for (const x of f.formatToParts(date || new Date())) o[x.type] = x.value;
  return { date: o.year + '-' + o.month + '-' + o.day, time: o.hour + ':' + o.minute, weekday: o.weekday,
    hour: Number(o.hour) % 24, minute: Number(o.minute) };
}

/* Self-governance: how much the company may decide alone, per category (company/state/governance.json, defaults in
 * company/defaults/state/governance.json). Returns 'auto' | 'notify' | 'approve'. Unknown category or unreadable file
 * => 'approve' (fail closed). The four owner gates are always 'approve'. */
const GOV_FILE = p('company', 'state', 'governance.json');
const GOV_DEFAULT = p('company', 'defaults', 'state', 'governance.json');
const LEVELS = ['auto', 'notify', 'approve'];
function governance() { return readJson(GOV_FILE, null) || readJson(GOV_DEFAULT, {}) || {}; }
function gate(category) {
  const g = governance();
  if (g.fixed && g.fixed[category] && guard('ownerGates')) return 'approve';
  const v = g.categories && g.categories[category];
  return LEVELS.includes(v) ? v : 'approve';
}

/* Halt state (company/state/halt.json, written by company/tools/halt.js): { mode: 'running' | 'soft' | 'hard', ... }.
 * Every tool that starts work checks co.halted() first; soft = start nothing new, let running work finish. */
const HALT_FILE = p('company', 'state', 'halt.json');
function haltState() { return readJson(HALT_FILE, { mode: 'running' }) || { mode: 'running' }; }
function halted() { const m = haltState().mode; return m === 'soft' || m === 'hard' ? m : false; }

/* Guardrails: hard blocks, one switch each (company/state/guardrails.json, defaults in company/defaults/state/).
 * co.guard(name) === true means the block is ON. Unknown name or unreadable file => ON (fail closed); 'halt' is always ON.
 * When 'ownerGates' is off, gate() no longer forces the fixed gates to 'approve'. */
const GUARD_FILE = p('company', 'state', 'guardrails.json');
const GUARD_DEFAULT = p('company', 'defaults', 'state', 'guardrails.json');
function guardrails() { return readJson(GUARD_FILE, null) || readJson(GUARD_DEFAULT, {}) || {}; }
function guard(name) {
  if (name === 'halt') return true;
  const g = guardrails().guards || {};
  return g[name] !== false;
}

module.exports = { ROOT, p, config, readJson, STATION_URL, TZ, SECRETS_DIR, secret, stationToken, LOOPS_FILE, crew,
  holds, ceo, seatFor, nameOf, localParts, GOV_FILE, governance, gate, HALT_FILE, haltState, halted,
  GUARD_FILE, guardrails, guard };
