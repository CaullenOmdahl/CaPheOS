'use strict';
/* modules.js — the runtime side of core modules (docs/CORE-MODULES.md "The module mechanism"): which modules are
 * enabled, and the two generic hooks that run them — the dispatcher's tick hook and the console's HTTP mount.
 *
 *   const mods = require('./lib/modules');
 *   mods.enabled()                 ids enabled in company/state/modules.json (written only by company/tools/module.js)
 *   mods.isEnabled(id)
 *   mods.dir(id)                   <ROOT>/modules/<id>
 *   await mods.runTicks({ log, dry, halted })   dispatcher hook: each enabled module's tick.js, fail-safe, in id order
 *   mods.httpRoutes()              console hook: [{ id, method, path, auth, re, keys, handler }] from each enabled http.js
 *
 * tick.js:  module.exports = { tick: async ({ log, dry, co, id, halted }) => any, runWhenHalted?: true, timeoutMs?: N }
 *   A halted company (co.halted()) runs only modules that export runWhenHalted: true (liveness). A throw, a rejection or
 *   a timeout (default 60 s) is logged as "MODULE <id> TICK ERROR: ..." and never stops the dispatcher.
 * http.js:  module.exports = { routes: [{ method, path, auth: 'owner' | 'source', handler(req, res, ctx) }] }
 *   'owner'  -> /api/m/<id>/<path>  (behind the console's owner token)
 *   'source' -> /hooks/<id>/<path>  (no owner token; the module authenticates the caller itself, e.g. HMAC on ctx.body)
 *   path segments may be ":name" (ctx.params.name). See console/server.js for ctx.
 * A module that is not enabled has no tick and no route, whatever files it ships.
 */
const fs = require('fs');
const path = require('path');
const co = require('./company');

const MODULES_DIR = co.p('modules');
const STATE_FILE = co.p('company', 'state', 'modules.json');
const ID_RE = /^[a-z][a-z0-9-]{1,39}$/;

function state() { const s = co.readJson(STATE_FILE, {}) || {}; s.enabled = s.enabled || {}; return s; }
function enabled() { return Object.keys(state().enabled).filter(id => ID_RE.test(id)).sort(); }
function isEnabled(id) { return enabled().includes(id); }
function dir(id) { return path.join(MODULES_DIR, id); }
function load(id, file) {
  const f = path.join(dir(id), file);
  if (!fs.existsSync(f)) return null;
  return require(f);
}

function withTimeout(p, ms, what) {
  let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(what + ' timed out after ' + ms + ' ms')), ms); if (t.unref) t.unref(); })]).finally(() => clearTimeout(t));
}

async function runTicks({ log, dry, halted } = {}) {
  const say = log || (() => {});
  const out = [];
  for (const id of enabled()) {
    let m;
    try { m = load(id, 'tick.js'); } catch (e) { say('MODULE ' + id + ' TICK ERROR: cannot load tick.js: ' + String(e.message).slice(0, 200)); out.push({ id, error: e.message }); continue; }
    if (!m || typeof m.tick !== 'function') continue;
    if (halted && m.runWhenHalted !== true) { out.push({ id, skipped: 'halted' }); continue; }
    try {
      const r = await withTimeout(Promise.resolve().then(() => m.tick({ log: say, dry: !!dry, co, id, halted: halted || false })), Number(m.timeoutMs) > 0 ? Number(m.timeoutMs) : 60000, 'tick');
      out.push({ id, ok: true, result: r });
    } catch (e) { say('MODULE ' + id + ' TICK ERROR: ' + String(e && e.message || e).slice(0, 200)); out.push({ id, error: String(e && e.message || e) }); }
  }
  return out;
}

function pathRe(p) {
  const keys = [];
  const segs = String(p || '').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  const re = segs.map(s => s.startsWith(':') ? (keys.push(s.slice(1)), '([^/]+)') : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/');
  return { re: new RegExp('^' + re + '$'), keys };
}
function httpRoutes(opts) {
  const say = (opts && opts.log) || (() => {});
  const out = [];
  for (const id of enabled()) {
    let m;
    try { m = load(id, 'http.js'); } catch (e) { say('module ' + id + ': cannot load http.js: ' + e.message); continue; }
    if (!m || !Array.isArray(m.routes)) continue;
    for (const r of m.routes) {
      if (!r || typeof r.handler !== 'function' || !['owner', 'source'].includes(r.auth)) { say('module ' + id + ': route skipped (needs handler and auth owner|source)'); continue; }
      const { re, keys } = pathRe(r.path);
      out.push({ id, method: String(r.method || 'GET').toUpperCase(), path: String(r.path || ''), auth: r.auth, re, keys, handler: r.handler });
    }
  }
  return out;
}

module.exports = { MODULES_DIR, STATE_FILE, ID_RE, state, enabled, isEnabled, dir, load, runTicks, httpRoutes, pathRe };
