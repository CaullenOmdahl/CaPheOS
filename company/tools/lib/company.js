'use strict';
/* company.js — the one place every CaPheOS tool learns who the company is, where things live, and who holds a seat.
 *
 * Nothing in company/tools may hardcode a person's name, a company name, an owner name, a timezone, a port or an
 * absolute path. Read them from here:
 *
 *   const co = require('./lib/company');        // from company/tools/*.js
 *   co.ROOT                  project root (the folder holding company/, secrets/, starnet/, .starnet-data/); env CAPHEOS_ROOT wins
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
 *   co.departmentsOf()       company/departments.json .departments ([] when the file is missing: no departments)
 *   co.deptOf(seat)          the department a seat is a member (or the lead) of, or null (lib/departments.js)
 *   co.leadOf(seat)          the seat's department lead; the seat's manager when its department has no lead; null when
 *                            the seat is in no department (docs/DEPARTMENTS.md)
 *
 * Functions (loops.json seat.functions): ceo, people, tools, risk, floor, finance. A seat may hold several; the founder
 * holds all of them until the company hires. Legacy flags hr:true / toolsOwner:true are read as people / tools.
 */
const fs = require('fs');
const path = require('path');

// env CAPHEOS_ROOT points every tool at another checkout's root (the console selftest runs against a temp copy).
const ROOT = process.env.CAPHEOS_ROOT ? path.resolve(process.env.CAPHEOS_ROOT) : path.resolve(__dirname, '..', '..', '..');
const p = (...parts) => path.join(ROOT, ...parts);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

const config = readJson(p('company', 'company.json'), {});
config.owner = config.owner || { name: 'Owner', title: 'Owner', addressAs: 'the owner' };
config.station = config.station || {};

// The station address comes from STARNET_URL or company.json; there is no guessed default port (a wrong guess is a
// silent connection error in every tool). Resolved lazily: a tool that never talks to the station (selftests, file-only
// tools) loads fine without one, and the first real use names the problem.
function resolveStationUrl() {
  if (process.env.STARNET_URL) return process.env.STARNET_URL;
  if (config.station.url) return config.station.url;
  if (config.station.port) return 'http://127.0.0.1:' + config.station.port;
  throw new Error('station address unknown: set STARNET_URL or company/company.json station.url (or station.port)');
}
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

/* Departments (company/departments.json, written only by company/tools/departments.js; docs/DEPARTMENTS.md). Read fresh on
 * every call, like crew(). A missing file = no departments: deptOf and leadOf are null and every tool behaves as before. */
const depts = () => require('./departments');
function departmentsOf() { return depts().list(depts().load({ root: ROOT }).doc); }
function deptOf(seat) { return depts().deptOf(seat, depts().load({ root: ROOT }).doc); }
function leadOf(seat) { return depts().leadOf(seat, depts().load({ root: ROOT }).doc, crew()); }

/* Local wall-clock pieces in the company timezone, for tools that reason about "today" or office hours. */
function localParts(date) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short' });
  const o = {}; for (const x of f.formatToParts(date || new Date())) o[x.type] = x.value;
  return { date: o.year + '-' + o.month + '-' + o.day, time: o.hour + ':' + o.minute, weekday: o.weekday,
    hour: Number(o.hour) % 24, minute: Number(o.minute) };
}

/* Self-governance: how much the company may decide alone, per category (company/state/governance.json, defaults in
 * company/defaults/state/governance.json). Returns 'auto' | 'notify' | 'triage' | 'approve'. Unknown category or
 * unreadable file => 'approve' (fail closed). The four owner gates are always 'approve' and never 'triage'.
 * 'triage' (a decision model decides between notify and approve: lib/governance.js decide) is returned only to a caller
 * that passes { triage: true }; every other caller sees 'approve' for it, so a tool that does not know triage stays closed. */
const GOV_FILE = p('company', 'state', 'governance.json');
const GOV_DEFAULT = p('company', 'defaults', 'state', 'governance.json');
const LEVELS = ['auto', 'notify', 'triage', 'approve'];
function governance() { return readJson(GOV_FILE, null) || readJson(GOV_DEFAULT, {}) || {}; }
function gate(category, opts) {
  const g = governance();
  if (g.fixed && g.fixed[category]) {
    if (guard('ownerGates')) return 'approve';
    const fv = g.fixedLevels && g.fixedLevels[category];   // ownerGates OFF: the owner may set a level for a fixed gate (governance.js set)
    return LEVELS.includes(fv) && fv !== 'triage' ? fv : 'approve';
  }
  const v = g.categories && g.categories[category];
  if (v === 'triage') return opts && opts.triage && !(g.fixed && g.fixed[category]) ? 'triage' : 'approve';
  return LEVELS.includes(v) ? v : 'approve';
}

/* Halt state (company/state/halt.json, written by company/tools/halt.js): { mode: 'running' | 'soft' | 'hard', ... }.
 * Every tool that starts work checks co.halted() first; soft = start nothing new, let running work finish. */
const HALT_FILE = p('company', 'state', 'halt.json');
function haltState() { return readJson(HALT_FILE, { mode: 'running' }) || { mode: 'running' }; }
function halted() { const m = haltState().mode; return m === 'soft' || m === 'hard' ? m : false; }
/* Restart hold (company/state/restart-hold.json, written only by company/tools/restart-station.js while it waits for an
 * idle station to restart it): { by, at, reason, pid, expiresAt, ... }. While it holds, nothing new starts — the
 * dispatcher wakes nobody, hiring does not advance — exactly as a soft halt, but no shutdown routine runs and nothing is
 * told to wind down. A hold past its expiresAt (the script died) holds nothing. startsHeld(): why nothing may start now
 * ('soft' | 'hard' | 'restart'), or false. */
const RESTART_HOLD_FILE = p('company', 'state', 'restart-hold.json');
function restartHold(now) {
  const h = readJson(RESTART_HOLD_FILE, null);
  if (!h || typeof h !== 'object' || h.watching === true) return null;   // watching: the hold is lifted, the script only watches
  const exp = Date.parse(String(h.expiresAt || ''));
  if (!Number.isFinite(exp) || exp <= (Number.isFinite(now) ? now : Date.now())) return null;
  return h;
}
function startsHeld() { return halted() || (restartHold() ? 'restart' : false); }
/* A hold record that holds nothing any more because it is past its expiresAt (its script died): a check that finds the
 * scheduler off must still FAIL then, and can say why. */
function restartHoldExpired(now) {
  const h = readJson(RESTART_HOLD_FILE, null);
  if (!h || typeof h !== 'object' || h.watching === true) return null;
  return restartHold(now) ? null : h;
}
/* the plain words a status check uses for an active hold instead of FAIL: "paused for a station restart (since 17:03,
 * expires 18:48)" */
function restartHoldNote(h) {
  h = h || restartHold(); if (!h) return null;
  const t = v => { const n = Date.parse(String(v || '')); return Number.isFinite(n) ? localParts(new Date(n)).time : '?'; };
  return 'paused for a station restart (since ' + t(h.at) + ', expires ' + t(h.expiresAt) + (h.reason ? '; ' + String(h.reason).slice(0, 80) : '') + ')';
}

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

module.exports = { ROOT, p, config, readJson, TZ, SECRETS_DIR, secret, stationToken, LOOPS_FILE, crew,
  holds, ceo, seatFor, nameOf, departmentsOf, deptOf, leadOf, localParts, GOV_FILE, LEVELS, governance, gate, HALT_FILE, haltState, halted,
  RESTART_HOLD_FILE, restartHold, startsHeld, restartHoldExpired, restartHoldNote,
  GUARD_FILE, guardrails, guard };

Object.defineProperty(module.exports, 'STATION_URL', { enumerable: true, get: resolveStationUrl });
