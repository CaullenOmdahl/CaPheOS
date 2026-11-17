'use strict';
/* duty-env.js — the environment a duty check runs in (docs/DUTIES.md "Execution").
 *
 * A duty is read-only detection code run by the dispatcher on every tick. It gets an ALLOWLIST environment, never the
 * dispatcher's own: no station token, no provider key, no secret of any kind, nothing that changes how node starts.
 *
 *   const { dutyEnv, ALLOW } = require('./lib/duty-env');
 *   dutyEnv({ root, base? })  -> { env, source: 'starnet' | 'local' }
 *
 * The allowlist: PATH, HOME, TZ, LANG, CAPHEOS_TZ, CAPHEOS_BACKUP_DIR (names, never secrets) from the dispatcher's
 * environment, plus CAPHEOS_ROOT=<root>, CAPHEOS_READONLY=1 and CAPHEOS_NO_NETWORK=1 (the flags a duty honours: it
 * writes nothing and opens no socket). NODE_OPTIONS, NODE_PATH and every other variable are left out.
 * When StarNet is installed next to the company (starnet/sidecar/environment.js), its sanitizeChildEnv is applied on
 * top, and a name it strips is dropped here too: the allowlist can only get smaller, never larger. Without StarNet the
 * local rule below is the same idea: a secret-shaped name never passes, whatever list it is on.
 */
const fs = require('fs');
const path = require('path');

const ALLOW = ['PATH', 'HOME', 'TZ', 'LANG', 'CAPHEOS_TZ', 'CAPHEOS_BACKUP_DIR'];
const FORCED = { CAPHEOS_READONLY: '1', CAPHEOS_NO_NETWORK: '1' };
// the same shape StarNet strips for agent commands (environment.js SECRET_ENV_NAME_RE), kept here for a company without it
const SECRET_NAME = /(?:^|_)(?:TOKEN|KEY|SECRET|PASSWORD|PASS|AUTH|BEARER|COOKIE|CREDENTIAL)(?:_|$)|(?:APIKEY|ACCESSTOKEN|ACCESSKEY|SECRETKEY|AUTHTOKEN|APITOKEN|PRIVATEKEY|PASSWD)|(?:^|_)PAT(?:_|$)|^(?:STARNET|SKYNET)_|^NODE_(?:OPTIONS|PATH)$/i;

function starnetSanitizer(root) {
  const f = path.join(root, 'starnet', 'sidecar', 'environment.js');
  if (!fs.existsSync(f)) return null;
  try { const m = require(f); return typeof m.sanitizeChildEnv === 'function' ? m.sanitizeChildEnv : null; } catch (_) { return null; }
}

function dutyEnv(opts) {
  opts = opts || {};
  const root = path.resolve(opts.root || process.env.CAPHEOS_ROOT || path.resolve(__dirname, '..', '..', '..'));
  const base = opts.base || process.env;
  const env = {};
  for (const k of ALLOW) if (base[k] != null && base[k] !== '' && !SECRET_NAME.test(k)) env[k] = String(base[k]);
  env.CAPHEOS_ROOT = root;
  Object.assign(env, FORCED);
  if (!env.PATH) env.PATH = '/usr/local/bin:/usr/bin:/bin';
  const sanitize = opts.sanitize === undefined ? starnetSanitizer(root) : opts.sanitize;
  let source = 'local';
  if (sanitize) {
    try {
      const kept = sanitize(Object.assign({}, env));
      for (const k of Object.keys(env)) if (!(k in kept) && k !== 'CAPHEOS_ROOT' && !(k in FORCED)) delete env[k];
      source = 'starnet';
    } catch (_) { source = 'local'; }
  }
  return { env, source };
}

module.exports = { dutyEnv, ALLOW, FORCED, SECRET_NAME };
