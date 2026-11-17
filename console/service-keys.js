/* console/service-keys.js — Settings › Connections and keys › Service keys, server side. Spec: docs/CONSOLE-API.md
 * "Service keys".
 *
 * The owner's own view of secrets/: every key file the company has (never the station or console token, never this
 * folder's README), in plain words ("Pyth", "Kalshi private key", "Heartbeat address (healthchecks.io)"), set or not,
 * when it last changed and which tools read it (a cached grep of co.secret('<name>') in company/tools, company/work,
 * modules and packs). Add and Replace go through the console's one secret writer (console/server.js writeSecret: a
 * validated name, 0600, atomic, recorded with company/tools/provenance.js as the owner's change so locked-watch.js
 * accepts it); the CEO gets a short OPEN handoff naming the file. A value is never read back, returned, logged or put in
 * the handoff. Pure helpers (KNOWN, describe, markSaved) are also used by the dev mock (console/ui/dev/mock-api.js).
 */
'use strict';
const fs = require('fs');
const path = require('path');

// The services the Add form offers, and the friendly names of the files they and the framework use. kind 'address' is a
// web address (a ping URL), labelled "address", never "key". `names` are the file names this entry describes. `connector`:
// the same service's sign-in in company/connectors/<id>.json (console/connectors.js), the way to get it without pasting.
const KNOWN = [
  { id: 'pyth', label: 'Pyth', name: 'pyth-api-key', names: ['pyth-api-key', 'pyth-key', 'pyth-token'], kind: 'key', offer: true,
    where: 'Sign in at Pyth, open API keys and create one; copy the key it shows.', url: 'https://app.pyth.com' },
  { id: 'kalshi', label: 'Kalshi API key', name: 'kalshi-api-key', names: ['kalshi-api-key', 'kalshi-key', 'kalshi-key-id'], kind: 'key', offer: true,
    where: 'Kalshi › Account › API keys: create a key. Its Key ID goes here; the private key file it downloads goes in "Kalshi private key".', url: 'https://kalshi.com/account/profile' },
  { id: 'kalshi-private', label: 'Kalshi private key', name: 'kalshi-private-key', names: ['kalshi-private-key', 'kalshi-private-key.pem', 'kalshi-key.pem'], kind: 'key', multiline: true, offer: true,
    where: 'The private key file Kalshi downloaded when you created the API key: open it and paste all of it, BEGIN and END lines included.', url: 'https://kalshi.com/account/profile' },
  { id: 'synpath', label: 'Synpath', name: 'synpath-api-key', names: ['synpath-api-key', 'synpath-key', 'synpath-token'], kind: 'key', offer: true,
    where: 'Easiest: Sign-ins above › Synpath › Connect (you sign in with Google; the station keeps the key it creates). Or sign in at synpath.dev and copy an API key from its API settings.', url: 'https://www.synpath.dev/tick-data', connector: 'synpath' },
  { id: 'healthchecks', label: 'Heartbeat address (healthchecks.io)', name: 'liveness-heartbeat-url', names: ['liveness-heartbeat-url', 'healthchecks-url', 'healthchecks-ping-url'], kind: 'address', offer: true,
    where: 'healthchecks.io › your project › Add Check, then copy its ping address (https://hc-ping.com/…). The liveness check calls it while all is well.', url: 'https://healthchecks.io/accounts/signup/' },
  { id: 'github', label: 'GitHub token', name: 'github-token', names: ['github-token', 'gh-token', 'github-pat'], kind: 'key', offer: true,
    where: 'GitHub › Settings › Developer settings › Fine-grained tokens: give it only the repositories and permissions it needs.', url: 'https://github.com/settings/personal-access-tokens/new', connector: 'github-cli' },
  // not offered in the picker (set elsewhere, or by the framework), but named when the file is there
  { id: 'healthchecks-key', label: 'healthchecks.io ping key', names: ['healthchecks-ping-key'], kind: 'key', where: 'healthchecks.io › your project › Settings › Ping key.', url: 'https://healthchecks.io/' },
  { id: 'liveness-alert', label: 'Outage alert address', names: ['liveness-ping-url'], kind: 'address', where: 'An address the liveness check calls once when the station goes down (a ntfy.sh or healthchecks.io /fail address).', url: null },
  { id: 'minimax', label: 'MiniMax plan key', names: ['minimax-key'], kind: 'key', where: 'Set it under API keys above; this copy is the one tools read directly.', url: null },
  { id: 'deepseek', label: 'DeepSeek key (vision checks)', names: ['deepseek-key'], kind: 'key', where: 'platform.deepseek.com › API keys.', url: 'https://platform.deepseek.com/api_keys' },
  { id: 'openrouter', label: 'OpenRouter key', names: ['openrouter-key'], kind: 'key', where: 'openrouter.ai › Keys.', url: 'https://openrouter.ai/keys' },
  { id: 'openrouter-mgmt', label: 'OpenRouter management key (spend gate)', names: ['openrouter-mgmt-key'], kind: 'key', where: 'openrouter.ai › Keys › Provisioning keys.', url: 'https://openrouter.ai/settings/provisioning-keys' },
];
// files in secrets/ that are the framework's, never listed and never written from here
const RESERVED = new Set(['readme.md', 'station-token', 'console-token']);
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const safeName = n => NAME.test(String(n || '')) && !RESERVED.has(String(n).toLowerCase()) && !String(n).includes('..');

const knownOf = name => KNOWN.find(k => k.names.includes(String(name).toLowerCase())) || null;
// "acme-feed-token" -> "Acme feed token"; "x_api_key" -> "X API key"
function humanize(name) {
  const s = String(name).replace(/\.(pem|key|txt)$/i, '').replace(/[-_.]+/g, ' ').trim()
    .replace(/\b(api|url|id|pem|ssh|gpg|aws|gcp)\b/gi, w => w.toUpperCase()).replace(/\bURL\b/, 'address');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : String(name);
}
const kindOfName = name => /(^|[-_.])(url|uri|address|webhook)$/i.test(String(name)) ? 'address' : 'key';
function describe(name) {
  const k = knownOf(name);
  if (k) return { name, label: k.label, kind: k.kind, service: k.id, where: k.where, url: k.url, multiline: !!k.multiline };
  const kind = kindOfName(name);
  return { name, label: humanize(name), kind, service: null, where: null, url: null, multiline: /\.pem$|private/i.test(name) };
}
const offers = () => KNOWN.filter(k => k.offer).map(k => ({ id: k.id, label: k.label, name: k.name, kind: k.kind, where: k.where, url: k.url, multiline: !!k.multiline }));

// A copy of an open question with each secret field whose file exists marked {saved: {at}} (Today: "Already saved —
// replace?"). savedAt(name) -> ISO time or null.
function markSaved(q, savedAt) {
  const markForm = form => {
    if (!form || !Array.isArray(form.fields)) return form;
    return Object.assign({}, form, { fields: form.fields.map(f => {
      if (!f || f.type !== 'secret' || !f.name) return f;
      const at = savedAt(f.name); return at ? Object.assign({}, f, { saved: { at } }) : f;
    }) });
  };
  const o = Object.assign({}, q);
  if (o.form) o.form = markForm(o.form);
  if (Array.isArray(o.questions)) o.questions = o.questions.map(p => p && p.form ? Object.assign({}, p, { form: markForm(p.form) }) : p);
  return o;
}

// who reads which key: co.secret('<name>') in JS, secrets/<name> in Python and shell. Cached for a minute.
const SCAN_DIRS = [['company', 'tools'], ['company', 'work'], ['modules'], ['packs']];
const SKIP_DIR = /^(node_modules|\.git|tests?|fixtures|__pycache__|\.starnet-data|state|locked)$/;
const JS_RE = /\bco\.secret\(\s*['"]([A-Za-z0-9][A-Za-z0-9._-]{0,63})['"]/g;
const SH_RE = /\bsecrets\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})/g;
function scanUsage(root) {
  const uses = new Map(); let files = 0;
  const walk = (dir, depth) => {
    if (depth > 6 || files > 5000) return;
    let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIR.test(e.name)) walk(f, depth + 1); continue; }
      if (!e.isFile() || !/\.(c?js|mjs|py|sh)$/.test(e.name)) continue;
      let t; try { if (fs.statSync(f).size > 512 * 1024) continue; t = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
      files++;
      const rel = path.relative(root, f).split(path.sep).join('/');
      for (const re of /\.(py|sh)$/.test(e.name) ? [JS_RE, SH_RE] : [JS_RE]) {
        re.lastIndex = 0; let m;
        while ((m = re.exec(t))) { const n = m[1]; if (RESERVED.has(n.toLowerCase()) || /\.(md|tmp)$/i.test(n)) continue; if (!uses.has(n)) uses.set(n, new Set()); uses.get(n).add(rel); }
      }
    }
  };
  for (const d of SCAN_DIRS) walk(path.join(root, ...d), 0);
  return uses;
}
// a reader in plain words: "the liveness module", "the vision tool", "the research scripts"
function readerOf(rel) {
  const p = rel.split('/');
  if (p[0] === 'modules' && p[1]) return 'the ' + p[1] + ' module';
  if (p[0] === 'packs' && p[1]) return 'the ' + p[1] + ' pack';
  if (p[0] === 'company' && p[1] === 'tools') return 'the ' + p[p.length - 1].replace(/\.[a-z]+$/, '').replace(/[-_]+/g, ' ') + ' tool';
  if (p[0] === 'company' && p[1] === 'work' && p[2]) return 'the ' + p[2].replace(/[-_]+/g, ' ') + ' work';
  return 'a company script';
}

module.exports = function serviceKeys({ co, bad, HttpError, writeSecret, normalizeSecret, owner, tool }) {
  let cache = null;
  const usage = () => { if (!cache || Date.now() - cache.at > 60e3) cache = { at: Date.now(), uses: scanUsage(co.ROOT) }; return cache.uses; };
  const fileOf = name => path.join(co.SECRETS_DIR, name);
  function savedAt(name) {
    if (!safeName(name)) return null;
    try { const st = fs.statSync(fileOf(name)); return st.isFile() && st.size > 0 ? new Date(st.mtimeMs).toISOString() : null; } catch (_) { return null; }
  }
  function row(name, uses) {
    const d = describe(name); const at = savedAt(name);
    const files = [...(uses.get(name) || [])].sort();
    return Object.assign(d, { set: !!at, changedAt: at, usedBy: [...new Set(files.map(readerOf))], files, stored: 'secrets/' + name });
  }
  function list() {
    const uses = usage();
    let names = [];
    try { names = fs.readdirSync(co.SECRETS_DIR).filter(n => safeName(n) && !n.startsWith('.') && (() => { try { return fs.statSync(fileOf(n)).isFile(); } catch (_) { return false; } })()); } catch (_) {}
    // keys a tool reads that are not there yet: a known service, or one a company script or module reads
    for (const [n, fs_] of uses) {
      if (names.includes(n) || !safeName(n)) continue;
      if (knownOf(n) || [...fs_].some(f => !f.startsWith('company/tools/'))) names.push(n);
    }
    const rows = names.map(n => row(n, uses)).sort((a, b) => (b.set - a.set) || a.label.localeCompare(b.label));
    return { ok: true, keys: rows, services: offers(), reserved: [...RESERVED].filter(n => n !== 'readme.md') };
  }
  function save(b) {
    b = b || {};
    const known = b.service ? KNOWN.find(k => k.id === String(b.service) && k.offer) : null;
    if (b.service && b.service !== 'other' && !known) bad('unknown service "' + String(b.service).slice(0, 40) + '"; pick one from the list or Other');
    const name = String(b.name || (known && known.name) || '').trim();
    if (!name) bad('give the key a name (letters, digits, . _ -)');
    if (RESERVED.has(name.toLowerCase())) bad('"' + name + '" is the framework\'s own file; it cannot be set from here');
    if (!safeName(name)) bad('the name may use letters, digits, . _ - only (no folders), up to 64 characters');
    if (typeof b.value !== 'string' || !b.value.trim()) bad('paste the key first');
    const value = normalizeSecret(b.value);
    if (value.length > 16384) bad('longer than 16 KB; is this the key?');
    const d = describe(name);
    if (d.kind === 'address') {
      let u = null; try { u = new URL(value); } catch (_) {}
      if (!u || !/^https?:$/.test(u.protocol) || /\s/.test(value)) bad('this one is a web address: paste the whole address, starting with https://');
    }
    const existed = !!savedAt(name) || fs.existsSync(fileOf(name));
    if (existed && !b.replace) throw new HttpError(409, d.label + ' is already saved. Use Replace to overwrite it.', { code: 'exists', name });
    writeSecret(name, value, true);   // records provenance (the owner's change) and refuses a name outside secrets/
    const told = tellCeo(d, existed);
    cache = null;
    return { ok: true, name, label: d.label, kind: d.kind, stored: 'secrets/' + name, chars: value.length, replaced: existed, told };
  }
  // the CEO's inbox: one short OPEN handoff, so whoever was waiting for the key hears it is there (never the value)
  function tellCeo(d, replaced) {
    try {
      const ceo = co.ceo(); if (!ceo) return null;
      const kit = tool(path.join('lib', 'modkit.js'));
      const inbox = kit.appendHandoff(ceo, 'The owner ' + (replaced ? 'replaced' : 'saved') + ' ' + d.label + ' (secrets/' + d.name + ')', {
        What: 'The owner ' + (replaced ? 'replaced' : 'saved') + ' ' + d.label + ' (secrets/' + d.name + ') in Settings › Connections and keys.',
        Need: 'If anyone was waiting for it, tell them it is there. A tool reads it with co.secret(\'' + d.name + '\'); never print, log or paste it. Then set Status to DONE.',
      }, 'Console (for ' + owner() + ')');
      return inbox ? co.nameOf(ceo) : null;
    } catch (_) { return null; }
  }
  return { list, save, savedAt, markSaved: q => markSaved(q, savedAt) };
};
Object.assign(module.exports, { KNOWN, RESERVED, safeName, describe, offers, markSaved, humanize, scanUsage, readerOf });
