#!/usr/bin/env node
/* guardrails.js — the owner's switches for the company's hard blocks, one per block, including none at all.
 *
 *   node company/tools/guardrails.js show [--json]               every switch, what it blocks, ON/OFF, where it is enforced
 *   node company/tools/guardrails.js set <name> on|off --by <owner> [--why "..."]
 *   node company/tools/guardrails.js off-all --by <owner> --confirm "I understand there are no guardrails" [--why "..."]
 *   node company/tools/guardrails.js on-all --by <owner> [--why "..."]
 *   node company/tools/guardrails.js sandbox on|off --by <owner>  record that the station runs isolated (a container or VM)
 *   node company/tools/guardrails.js sandbox detect               do we look containerised? (informational only)
 *   node company/tools/guardrails.js apply [--dry-run] [--by <owner>]   push the station-side switches through the station API
 *   node company/tools/guardrails.js selftest                     offline, temp folder, fake station
 *
 * A guardrail is a stop that holds whatever anyone decides; a self-governance level (governance.json, governance.js) says
 * who decides. docs/GUARDRAILS.md has the whole picture.
 *
 * Only the owner changes anything: --by must be the owner's name (company/company.json owner.name) or "owner", and the
 * command must not run inside an agent's station run (lib/guardrails.js isAgentCaller(): the merge gate's detection plus
 * provenance.js's). 'halt' can never be switched off. Writes company/state/guardrails.json atomically (created from
 * company/defaults/state/guardrails.json when missing; the write is recorded with provenance.js), one JSON row per
 * change in company/state/guardrails-log.jsonl, one line in company/work/decisions.md, and a message to the owner
 * channel (owner-inbox.js send()) so the change is on record where the owner reads.
 *
 * Station side (apply): localComputer -> StarNet computer control (GET/POST /api/computer-control, {action:'select',
 * backend:'off'}) and the station's FULL BYPASS permission switch (GET /api/permissions, POST /api/permissions/bypass
 * {on}); secrets -> each service key's unattended grant (GET /api/servicekeys, POST /api/servicekeys/autonomy {id,
 * autonomous}). Only grants this tool turned on are turned back off (company/state/guardrails-applied.json), so a grant
 * the owner made in the station is left alone. Every other switch is framework-only: the station has no switch for it
 * (the injection tripwire, starnet/sidecar/cron-guard.js, is pure code with no mode), and `show` says so.
 * Exit: 0 ok, 2 bad usage or input, 3 refused (not the owner), 1 station or write error.
 * Owner of this tool: the tools function (co.seatFor('tools')). Policy: the owner.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const co = require('./lib/company');
const gr = require('./lib/guardrails');

const CONFIRM = 'I understand there are no guardrails';
const FIXED_ON = new Set(['halt']);

/* Where each switch is enforced and whether the station has a switch of its own. `files` are checked by `show` for a
 * guard('<name>') (or the name in quotes, for the shell and Python gates) so a switch that nothing reads yet is visible. */
const MAP = {
  ownerGates: { files: ['company/tools/lib/company.js', 'company/tools/lib/governance.js', 'company/tools/governance.js'] },
  spendCap: { files: ['company/tools/dispatch.js', 'company/tools/hire.js', 'company/tools/pacer.js'] },
  externalActions: { files: ['company/tools/external-gate.js'] },
  harnessSelfEdit: { files: ['company/tools/locked-watch.js', 'company/tools/harness-change.js'] },
  defaultBranch: { files: ['company/tools/merge-gate.js', 'company/tools/premerge-check.js', 'company/tools/default-branch-watch.js'] },
  secrets: { files: ['company/tools/my-section.js'],
    station: 'service keys: the unattended grant of each key (POST /api/servicekeys/autonomy). Off: apply grants unattended use of every enabled key that supports it; on: apply takes back only the grants it made' },
  localComputer: { files: ['company/tools/my-section.js', 'company/tools/workspace-modes.sh'],
    station: 'computer control (POST /api/computer-control select off) and the FULL BYPASS permission switch (POST /api/permissions/bypass). On: apply sets computer control off and bypass off; off: apply sets bypass on (computer control stays the owner\'s pick in the station: it needs the Windows desktop app)' },
  privilegedShell: { files: ['company/tools/sudo-gate/broker.py', 'company/tools/sudo-gate/install.sh'],
    note: 'the installed root broker trusts only its root-owned gate.json: turning this OFF takes effect after the owner runs `sudo bash company/tools/sudo-gate/install.sh`; turning it ON takes effect at once' },
  promptInjection: { files: [],
    note: 'framework-only and not switchable on the station: the tripwire (starnet/sidecar/cron-guard.js) has no mode or endpoint, so OFF is recorded but injection-shaped routine prompts are still refused' },
  halt: { files: ['company/tools/halt.js', 'company/tools/dispatch.js'], note: 'cannot be switched off' },
};

/* ---------------- context ---------------- */
function context(o) {
  o = o || {};
  const root = path.resolve(o.root || co.ROOT), P = (...a) => path.join(root, ...a);
  return {
    root, now: () => (o.now ? o.now() : Date.now()),
    isAgent: o.isAgent || gr.isAgentCaller,
    call: o.call || stationCall,
    notify: o.notify || notifyOwner,
    fsRoot: o.fsRoot || '/', env: o.env || process.env,
    files: { state: P('company', 'state', 'guardrails.json'), def: P('company', 'defaults', 'state', 'guardrails.json'),
      log: P('company', 'state', 'guardrails-log.jsonl'), applied: P('company', 'state', 'guardrails-applied.json'),
      decisions: P('company', 'work', 'decisions.md') },
  };
}
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text, { mode: 0o644 }); fs.renameSync(tmp, file);
  try { require('./provenance.js').wrote(file, text, 'guardrails.js'); } catch (_) {}
}
function append(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, text);
  try { require('./provenance.js').appended(file, text, 'guardrails.js'); } catch (_) {}
}
function load(ctx) {
  const cur = readJson(ctx.files.state, null);
  if (cur && cur.guards) return cur;
  const d = readJson(ctx.files.def, null) || readJson(co.p('company', 'defaults', 'state', 'guardrails.json'), null);
  if (!d || !d.guards) throw Object.assign(new Error('no guardrails defaults (company/defaults/state/guardrails.json)'), { code: 1 });
  return JSON.parse(JSON.stringify(d));
}
const isOn = (d, n) => n === 'halt' || ((d.guards || {})[n] !== false);
const ownerName = () => (co.config.owner && co.config.owner.name) || 'Owner';
const isOwnerName = by => { const b = String(by || '').trim().toLowerCase(); return !!b && (b === 'owner' || b === ownerName().trim().toLowerCase()); };
function refuseCaller(ctx, by) {
  if (!isOwnerName(by)) return 'only the owner changes guardrails: --by must be "' + ownerName() + '" or "owner"';
  if (ctx.isAgent()) return 'this runs inside an agent\'s station run: only the owner, from their own shell, changes guardrails';
  return null;
}
const err = (code, error) => ({ ok: false, code, error });

/* ---------------- owner channel ---------------- */
function notifyOwner(text) {
  let oi; try { oi = require('./owner-inbox.js'); } catch (_) { return false; }
  if (!oi || typeof oi.send !== 'function') return false;
  try { oi.send({ from: 'Guardrails (company/tools/guardrails.js)', text }); return true; } catch (_) { return false; }
}

/* ---------------- record a change ---------------- */
function record(ctx, by, why, changes, d, event) {
  const at = new Date(ctx.now()).toISOString();
  d.changedAt = at; d.changedBy = String(by);
  writeAtomic(ctx.files.state, JSON.stringify(d, null, 2) + '\n');
  append(ctx.files.log, JSON.stringify({ at, by: String(by), event, why: why || null, changes, sandbox: !!d.sandbox }) + '\n');
  if (!fs.existsSync(ctx.files.decisions)) append(ctx.files.decisions, '# Decisions\n\n');
  const lp = co.localParts(new Date(at));
  const what = changes.map(c => c.name + ' ' + c.from + ' -> ' + c.to).join(', ');
  append(ctx.files.decisions, '- ' + lp.date + ' ' + lp.time + ' ' + by + ' (owner) changed guardrails: ' + what + (why ? ' — ' + String(why).replace(/\s+/g, ' ').slice(0, 300) : '') + ' (company/tools/guardrails.js)\n');
  const off = gr.NAMES.filter(n => !isOn(d, n));
  const station = changes.some(c => MAP[c.name] && MAP[c.name].station) ? ' Station-side switches follow when the owner runs `node company/tools/guardrails.js apply`.' : '';
  const root = changes.some(c => c.name === 'privilegedShell' && c.to === 'off') ? ' The installed sudo gate passes sudo through only after `sudo bash company/tools/sudo-gate/install.sh`.' : '';
  const warn = off.length && !d.sandbox ? ' WARNING: guardrails are off and sandbox is not set; this station is not recorded as isolated.' : '';
  ctx.notify('Guardrails changed by ' + by + ': ' + what + '. Now off: ' + (off.length ? off.join(', ') : 'none') + '.' + station + root + warn);
  return at;
}

/* ---------------- commands ---------------- */
function setOne(ctx, name, val, by, why) {
  const r = refuseCaller(ctx, by); if (r) return err(3, r);
  if (!gr.NAMES.includes(name)) return err(2, 'unknown guardrail ' + name + '; one of ' + gr.NAMES.join(', '));
  if (val !== 'on' && val !== 'off') return err(2, 'say on or off');
  if (FIXED_ON.has(name) && val === 'off') return err(2, name + ' can never be switched off');
  const d = load(ctx);
  const from = isOn(d, name) ? 'on' : 'off';
  if (from === val && fs.existsSync(ctx.files.state)) return { ok: true, unchanged: true, name, state: val };
  d.guards = Object.assign({}, d.guards, { [name]: val === 'on' });
  record(ctx, by, why, [{ name, from, to: val }], d, 'set');
  return { ok: true, name, from, to: val, next: nextSteps([name], val) };
}
function setAll(ctx, val, by, why, confirm) {
  const r = refuseCaller(ctx, by); if (r) return err(3, r);
  if (val === 'off' && confirm !== CONFIRM) return err(2, 'off-all needs --confirm "' + CONFIRM + '" (exactly)');
  const d = load(ctx), changes = [];
  d.guards = Object.assign({}, d.guards);
  for (const n of gr.NAMES) {
    const to = FIXED_ON.has(n) ? 'on' : val, from = isOn(d, n) ? 'on' : 'off';
    d.guards[n] = to === 'on';
    if (from !== to) changes.push({ name: n, from, to });
  }
  if (!changes.length && fs.existsSync(ctx.files.state)) return { ok: true, unchanged: true, all: val };
  record(ctx, by, why, changes.length ? changes : [{ name: '(all)', from: 'defaults', to: val }], d, val === 'off' ? 'off-all' : 'on-all');
  return { ok: true, all: val, changes, next: nextSteps(changes.map(c => c.name), val), halt: 'on (always)' };
}
function setSandbox(ctx, val, by, why) {
  const r = refuseCaller(ctx, by); if (r) return err(3, r);
  if (val !== 'on' && val !== 'off') return err(2, 'sandbox on|off|detect');
  const d = load(ctx), from = d.sandbox ? 'on' : 'off';
  if (from === val && fs.existsSync(ctx.files.state)) return { ok: true, unchanged: true, sandbox: val };
  d.sandbox = val === 'on';
  record(ctx, by, why, [{ name: 'sandbox', from, to: val }], d, 'sandbox');
  const det = detect(ctx);
  return { ok: true, sandbox: val, detect: det, warning: d.sandbox && !det.containerised ? 'sandbox is now ON but this process does not look containerised; check it really is isolated' : undefined };
}
function nextSteps(names, val) {
  const out = [];
  if (names.some(n => MAP[n] && MAP[n].station)) out.push('node company/tools/guardrails.js apply --dry-run, then apply --by owner, to push the station-side switches');
  if (names.includes('privilegedShell') && val === 'off') out.push('sudo bash company/tools/sudo-gate/install.sh, so the installed root broker honours privilegedShell off');
  return out;
}

/* ---------------- detect: do we look containerised? (informational only) ---------------- */
function detect(ctx) {
  const F = p => path.join(ctx.fsRoot, p), hints = [];
  const has = p => { try { fs.accessSync(F(p)); return true; } catch (_) { return false; } };
  const read = p => { try { return fs.readFileSync(F(p), 'utf8'); } catch (_) { return ''; } };
  if (has('.dockerenv')) hints.push('/.dockerenv exists (Docker)');
  if (has('run/.containerenv')) hints.push('/run/.containerenv exists (Podman)');
  const cg = read('proc/1/cgroup') + '\n' + read('proc/self/cgroup');
  const m = cg.match(/docker|containerd|kubepods|libpod|lxc|machine\.slice\/systemd-nspawn/);
  if (m) hints.push('cgroup names ' + m[0]);
  if (ctx.env.container) hints.push('environment says container=' + String(ctx.env.container).slice(0, 40));
  const mi = read('proc/self/mountinfo').split('\n').find(l => / \/ \/ /.test(l) && / - overlay /.test(l));
  if (mi) hints.push('the root file system is an overlay mount');
  return { containerised: hints.length > 0, hints, note: 'informational only: nothing is decided from this; `sandbox on|off` is the owner\'s statement' };
}

/* ---------------- show ---------------- */
function wiredIn(root, name, files) {
  const re = new RegExp('guard\\(\\s*[\'"]' + name + '[\'"]|[\'"]' + name + '[\'"]');
  return files.filter(f => { try { return re.test(fs.readFileSync(path.join(root, f), 'utf8')); } catch (_) { return false; } });
}
function show(ctx) {
  const d = load(ctx), texts = d._guards || {};
  const rows = gr.NAMES.map(n => {
    const m = MAP[n] || { files: [] };
    return { name: n, on: isOn(d, n), blocks: texts[n] || '', enforcedIn: m.files, wiredIn: wiredIn(ctx.root, n, m.files),
      backing: m.station ? 'station-backed' : 'framework-only', station: m.station || null, note: m.note || null, fixed: FIXED_ON.has(n) };
  });
  const off = rows.filter(r => !r.on).map(r => r.name), det = detect(ctx);
  const banner = off.length && !d.sandbox
    ? 'GUARDRAILS OFF (' + off.join(', ') + ') AND SANDBOX IS NOT SET: agents run without these blocks on a station that is not recorded as isolated. Run it in a disposable container (docs/GUARDRAILS.md) and `sandbox on --by owner`, or `on-all --by owner`.'
    : null;
  return { ok: true, sandbox: !!d.sandbox, detect: det, off, banner, changedAt: d.changedAt || null, changedBy: d.changedBy || null, file: path.relative(ctx.root, fs.existsSync(ctx.files.state) ? ctx.files.state : ctx.files.def), guards: rows };
}
function printShow(s) {
  const L = [];
  if (s.banner) { const bar = '!'.repeat(100); L.push(bar, '!! ' + s.banner, bar, ''); }
  L.push('Guardrails (' + s.file + ')' + (s.changedAt ? ', last changed ' + s.changedAt + ' by ' + s.changedBy : '') + '; sandbox: ' + (s.sandbox ? 'ON' : 'off') +
    ' (detect: ' + (s.detect.containerised ? 'looks containerised: ' + s.detect.hints.join('; ') : 'does not look containerised') + ')');
  if (s.sandbox && !s.detect.containerised) L.push('  note: sandbox is ON but this process does not look containerised');
  for (const g of s.guards) {
    L.push('', (g.on ? '  ON   ' : '  OFF  ') + g.name + (g.fixed ? ' (fixed on)' : '') + '  [' + g.backing + ']');
    if (g.blocks) L.push('       blocks: ' + g.blocks);
    if (g.enforcedIn.length) L.push('       enforced in: ' + g.enforcedIn.map(f => f.replace(/^company\/tools\//, '') + (g.wiredIn.includes(f) ? '' : ' (does not read this switch yet)')).join(', '));
    if (g.station) L.push('       station: ' + g.station);
    if (g.note) L.push('       note: ' + g.note);
  }
  console.log(L.join('\n'));
}

/* ---------------- station ---------------- */
function stationCall(method, p, body) {
  const http = require('http'), U = new URL(co.STATION_URL);
  return new Promise((resolve, reject) => {
    let token; try { token = co.stationToken(); } catch (e) { reject(e); return; }   // used for the call, never printed
    const req = http.request({ hostname: U.hostname, port: U.port || 80, path: p, method, timeout: 15000,
      headers: Object.assign({ 'x-starnet-token': token }, body ? { 'Content-Type': 'application/json' } : {}) }, res => {
      let d = ''; res.on('data', c => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('timeout', () => req.destroy(new Error('station timeout')));
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
}
async function getJson(ctx, p) {
  try { const r = await ctx.call('GET', p); if (r.status !== 200) return { error: 'HTTP ' + r.status }; return JSON.parse(r.body); }
  catch (e) { return { error: String((e && e.message) || e).slice(0, 160) }; }
}
async function plan(ctx) {
  const d = load(ctx), applied = readJson(ctx.files.applied, {}) || {}, steps = [], notes = [];
  const lc = isOn(d, 'localComputer'), sec = isOn(d, 'secrets');
  const cc = await getJson(ctx, '/api/computer-control'), perms = await getJson(ctx, '/api/permissions');
  if (cc.error) notes.push('computer control: could not read GET /api/computer-control (' + cc.error + ')');
  if (perms.error) notes.push('permissions: could not read GET /api/permissions (' + perms.error + ')');
  if (lc) {
    if (!cc.error && cc.backend && cc.backend !== 'off') {
      if (cc.envLocked) notes.push('computer control is "' + cc.backend + '", set by the station\'s launch environment (STARNET_COMPUTER_DRIVER): the API cannot change it; restart the station without it');
      else steps.push({ guard: 'localComputer', what: 'computer control ' + cc.backend + ' -> off', method: 'POST', path: '/api/computer-control', body: { action: 'select', backend: 'off' } });
    }
    if (!perms.error && perms.masterBypass) steps.push({ guard: 'localComputer', what: 'FULL BYPASS on -> off', method: 'POST', path: '/api/permissions/bypass', body: { on: false }, after: a => { a.bypassByUs = false; } });
    if (!perms.error && perms.envFullAccess) notes.push('the station was started with full access in its environment (STARNET_FULL_ACCESS): the API cannot take it away; restart the station without it');
    notes.push('per-agent approval "full" (POST /api/agent/approval) also gives an agent host reach; apply leaves each agent\'s mode as the owner set it');
  } else {
    if (!perms.error && !perms.masterBypass && !perms.envFullAccess) steps.push({ guard: 'localComputer', what: 'FULL BYPASS off -> on', method: 'POST', path: '/api/permissions/bypass', body: { on: true }, after: a => { a.bypassByUs = true; } });
    notes.push('computer control stays ' + (cc.backend || 'as it is') + ': choosing a backend is the owner\'s pick in the station (TOOLS > COMPUTER CONTROL; the Windows desktop app only)');
  }
  const sk = await getJson(ctx, '/api/servicekeys');
  if (sk.error) notes.push('service keys: could not read GET /api/servicekeys (' + sk.error + ')');
  const keys = Array.isArray(sk.keys) ? sk.keys : [], ours = new Set(Array.isArray(applied.autonomyByUs) ? applied.autonomyByUs : []);
  if (!sec) {
    for (const k of keys) if (k && k.id && k.enabled !== false && k.unattendedSupported !== false && !k.autonomous)
      steps.push({ guard: 'secrets', what: 'service key ' + k.name + ': unattended use off -> on', method: 'POST', path: '/api/servicekeys/autonomy', body: { id: k.id, autonomous: true }, after: a => { ours.add(k.id); a.autonomyByUs = [...ours]; } });
  } else {
    for (const k of keys) {
      if (!k || !k.id || !k.autonomous) continue;
      if (ours.has(k.id)) steps.push({ guard: 'secrets', what: 'service key ' + k.name + ': unattended use on -> off (granted by guardrails apply)', method: 'POST', path: '/api/servicekeys/autonomy', body: { id: k.id, autonomous: false }, after: a => { ours.delete(k.id); a.autonomyByUs = [...ours]; } });
      else notes.push('service key ' + k.name + ': unattended use was granted in the station by the owner; left as it is');
    }
  }
  if (!isOn(d, 'promptInjection')) notes.push('promptInjection is off, but the station\'s tripwire has no switch: injection-shaped routine prompts are still refused (framework-only)');
  return { steps, notes, applied };
}
async function apply(ctx, o) {
  o = o || {};
  if (!o.dry) { const r = refuseCaller(ctx, o.by || 'owner'); if (r) return err(3, r); }
  const p = await plan(ctx);
  const out = { ok: true, dryRun: !!o.dry, steps: p.steps.map(s => ({ guard: s.guard, what: s.what, request: s.method + ' ' + s.path + ' ' + JSON.stringify(s.body) })), notes: p.notes };
  if (o.dry || !p.steps.length) return out;
  const a = Object.assign({}, p.applied), results = [];
  for (const s of p.steps) {
    let r; try { r = await ctx.call(s.method, s.path, s.body); } catch (e) { r = { status: 0, body: String((e && e.message) || e) }; }
    let j = {}; try { j = JSON.parse(r.body); } catch (_) {}
    const ok = r.status === 200 && j.ok !== false && !j.error;
    if (ok && s.after) s.after(a);
    results.push({ what: s.what, ok, status: r.status, error: ok ? undefined : String(j.error || j.reason || r.body || '').slice(0, 200) });
  }
  a.at = new Date(ctx.now()).toISOString();
  writeAtomic(ctx.files.applied, JSON.stringify(a, null, 2) + '\n');
  const by = o.by || 'owner';
  append(ctx.files.log, JSON.stringify({ at: a.at, by, event: 'apply', results }) + '\n');
  if (!fs.existsSync(ctx.files.decisions)) append(ctx.files.decisions, '# Decisions\n\n');
  const lp = co.localParts(new Date(a.at));
  append(ctx.files.decisions, '- ' + lp.date + ' ' + lp.time + ' ' + by + ' (owner) applied guardrails to the station: ' + results.map(r => r.what + (r.ok ? '' : ' (FAILED)')).join('; ') + ' (company/tools/guardrails.js)\n');
  ctx.notify('Guardrails applied to the station: ' + results.map(r => r.what + (r.ok ? '' : ' (FAILED: ' + r.error + ')')).join('; ') + '.');
  out.results = results; out.ok = results.every(r => r.ok);
  return out;
}

/* ---------------- selftest ---------------- */
function fakeStation(init) {
  const S = Object.assign({ backend: 'win32', envLocked: false, masterBypass: true, envFullAccess: false,
    keys: [{ id: 'k1', name: 'Maps', enabled: true, autonomous: false, unattendedSupported: true },
      { id: 'k2', name: 'Mail', enabled: true, autonomous: true, unattendedSupported: true },
      { id: 'k3', name: 'Pay', enabled: true, autonomous: false, unattendedSupported: false },
      { id: 'k4', name: 'Off', enabled: false, autonomous: false, unattendedSupported: true }] }, init || {});
  S.posts = [];
  const J = (o, status) => ({ status: status || 200, body: JSON.stringify(o) });
  S.call = async (m, p, b) => {
    if (m === 'GET' && p === '/api/computer-control') return J({ backend: S.backend, envLocked: S.envLocked });
    if (m === 'GET' && p === '/api/permissions') return J({ masterBypass: S.masterBypass, envFullAccess: S.envFullAccess });
    if (m === 'GET' && p === '/api/servicekeys') return J({ keys: S.keys });
    if (m !== 'POST') return J({ error: 'no route' }, 404);
    S.posts.push({ p, b });
    if (p === '/api/computer-control' && b.action === 'select') { S.backend = b.backend; return J({ backend: S.backend }); }
    if (p === '/api/permissions/bypass') { S.masterBypass = b.on === true; return J({ ok: true, masterBypass: S.masterBypass }); }
    if (p === '/api/servicekeys/autonomy') { const k = S.keys.find(x => x.id === b.id); if (!k) return J({ error: 'no such service key' }, 404); k.autonomous = !!b.autonomous; return J({ ok: true }); }
    return J({ error: 'no route' }, 404);
  };
  return S;
}
async function selftest() {
  const os = require('os'), assert = require('assert');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-selftest-'));
  const prevProv = process.env.PROVENANCE_ROOT; process.env.PROVENANCE_ROOT = T;
  fs.mkdirSync(path.join(T, 'company', 'defaults', 'state'), { recursive: true });
  fs.copyFileSync(co.p('company', 'defaults', 'state', 'guardrails.json'), path.join(T, 'company', 'defaults', 'state', 'guardrails.json'));
  const told = [], out = []; let bad = 0, agent = false;
  const ST = fakeStation();
  const ctx = context({ root: T, isAgent: () => agent, notify: t => { told.push(t); return true; }, call: ST.call, fsRoot: path.join(T, 'fsroot'), env: {} });
  const t = async (n, fn) => { try { await fn(); out.push('ok   ' + n); } catch (e) { bad++; out.push('FAIL ' + n + ': ' + e.message); } };
  const state = () => readJson(ctx.files.state, null);
  const logRows = () => (fs.existsSync(ctx.files.log) ? fs.readFileSync(ctx.files.log, 'utf8').trim().split('\n').map(JSON.parse) : []);

  await t('no state file: everything ON from the defaults copy, no banner; guardIn reads the same', async () => {
    const s = show(ctx);
    assert.ok(s.guards.every(g => g.on) && !s.banner && s.off.length === 0);
    assert.strictEqual(s.guards.find(g => g.name === 'promptInjection').backing, 'framework-only');
    assert.strictEqual(s.guards.find(g => g.name === 'localComputer').backing, 'station-backed');
    assert.strictEqual(gr.guardIn(T, 'defaultBranch'), true); assert.strictEqual(gr.guardIn(T, 'no-such-guard'), true);
  });
  await t('an agent caller is refused even with the owner\'s name; a wrong --by is refused; nothing is written', async () => {
    agent = true; let r = setOne(ctx, 'defaultBranch', 'off', 'owner'); agent = false;
    assert.strictEqual(r.code, 3); assert.ok(/agent/.test(r.error));
    r = setOne(ctx, 'defaultBranch', 'off', 'Sam'); assert.strictEqual(r.code, 3);
    agent = true; r = setAll(ctx, 'off', 'owner', null, CONFIRM); assert.strictEqual(r.code, 3); r = setSandbox(ctx, 'on', 'owner'); assert.strictEqual(r.code, 3); agent = false;
    assert.ok(!fs.existsSync(ctx.files.state) && !fs.existsSync(ctx.files.log) && told.length === 0);
  });
  await t('the owner sets one switch off: state, log row, decisions line, owner message, banner (sandbox not set)', async () => {
    const r = setOne(ctx, 'defaultBranch', 'off', 'owner', 'experiment');
    assert.ok(r.ok && r.from === 'on' && r.to === 'off');
    assert.strictEqual(state().guards.defaultBranch, false); assert.strictEqual(gr.guardIn(T, 'defaultBranch'), false);
    const L = logRows(); assert.strictEqual(L.length, 1); assert.deepStrictEqual(L[0].changes, [{ name: 'defaultBranch', from: 'on', to: 'off' }]); assert.strictEqual(L[0].why, 'experiment');
    assert.ok(/owner \(owner\) changed guardrails: defaultBranch on -> off — experiment/.test(fs.readFileSync(ctx.files.decisions, 'utf8')));
    assert.ok(told.length === 1 && /defaultBranch on -> off/.test(told[0]) && /WARNING/.test(told[0]));
    const s = show(ctx); assert.ok(s.banner && /defaultBranch/.test(s.banner));
    assert.ok(!fs.readdirSync(path.dirname(ctx.files.state)).some(f => /\.tmp-/.test(f)), 'no temp file left behind');
  });
  await t('halt can never be switched off; unknown names and bad values are refused', async () => {
    assert.strictEqual(setOne(ctx, 'halt', 'off', 'owner').code, 2);
    assert.strictEqual(setOne(ctx, 'nope', 'off', 'owner').code, 2);
    assert.strictEqual(setOne(ctx, 'secrets', 'maybe', 'owner').code, 2);
    assert.ok(isOn(state(), 'halt'));
  });
  await t('off-all needs the exact confirmation; with it every switch but halt is off', async () => {
    assert.strictEqual(setAll(ctx, 'off', 'owner', null, 'yes').code, 2);
    const r = setAll(ctx, 'off', 'owner', 'container experiment', CONFIRM);
    assert.ok(r.ok); const s = show(ctx);
    assert.deepStrictEqual(s.off.sort(), gr.NAMES.filter(n => n !== 'halt').sort());
    assert.ok(s.guards.find(g => g.name === 'halt').on && s.banner);
    assert.ok(r.next.some(x => /install\.sh/.test(x)) && r.next.some(x => /apply/.test(x)));
  });
  await t('sandbox on quiets the banner (still listed as off); detect reads container hints from the file system', async () => {
    const r = setSandbox(ctx, 'on', 'owner');
    assert.ok(r.ok && r.warning, 'not containerised yet: a warning');
    assert.ok(!show(ctx).banner && show(ctx).off.length === 9);
    fs.mkdirSync(path.join(T, 'fsroot', 'proc', '1'), { recursive: true });
    fs.writeFileSync(path.join(T, 'fsroot', '.dockerenv'), ''); fs.writeFileSync(path.join(T, 'fsroot', 'proc', '1', 'cgroup'), '0::/system.slice/docker-abc.scope\n');
    const d = detect(ctx); assert.ok(d.containerised && d.hints.length === 2, JSON.stringify(d));
    assert.ok(detect(context({ root: T, fsRoot: path.join(T, 'empty'), env: { container: 'podman' } })).containerised);
    assert.ok(!detect(context({ root: T, fsRoot: path.join(T, 'empty'), env: {} })).containerised);
  });
  await t('apply --dry-run with everything off: plans bypass on and unattended grants, posts nothing, anyone may dry-run', async () => {
    ST.masterBypass = false; agent = true;
    const r = await apply(ctx, { dry: true }); agent = false;
    assert.ok(r.ok && r.dryRun && ST.posts.length === 0);
    assert.deepStrictEqual(r.steps.map(s => s.what), ['FULL BYPASS off -> on', 'service key Maps: unattended use off -> on']);
    assert.ok(r.notes.some(n => /tripwire has no switch/.test(n)) && r.notes.some(n => /owner's pick/.test(n)));
  });
  await t('apply (not a dry run) is refused for an agent', async () => { agent = true; const r = await apply(ctx, { by: 'owner' }); agent = false; assert.strictEqual(r.code, 3); assert.strictEqual(ST.posts.length, 0); });
  await t('apply with everything off: the station gets bypass on and one unattended grant; the grant is remembered', async () => {
    const r = await apply(ctx, { by: 'owner' });
    assert.ok(r.ok && r.results.length === 2 && r.results.every(x => x.ok));
    assert.ok(ST.masterBypass && ST.keys.find(k => k.id === 'k1').autonomous && !ST.keys.find(k => k.id === 'k3').autonomous && !ST.keys.find(k => k.id === 'k4').autonomous);
    assert.deepStrictEqual(readJson(ctx.files.applied, {}).autonomyByUs, ['k1']);
    assert.ok(logRows().some(x => x.event === 'apply') && /applied guardrails to the station/.test(fs.readFileSync(ctx.files.decisions, 'utf8')));
    assert.strictEqual((await apply(ctx, { dry: true })).steps.length, 0, 'a second apply has nothing to do');
  });
  await t('on-all then apply: computer control off, bypass off, only the grant apply made is taken back', async () => {
    assert.ok(setAll(ctx, 'on', 'owner').ok); assert.ok(show(ctx).guards.every(g => g.on));
    const r = await apply(ctx, { by: 'owner' });
    assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(ST.backend, 'off'); assert.strictEqual(ST.masterBypass, false);
    assert.strictEqual(ST.keys.find(k => k.id === 'k1').autonomous, false); assert.strictEqual(ST.keys.find(k => k.id === 'k2').autonomous, true, 'the owner\'s own grant stays');
    assert.ok(r.notes.some(n => /Mail.*left as it is/.test(n)));
    assert.deepStrictEqual(readJson(ctx.files.applied, {}).autonomyByUs, []);
  });
  await t('apply when the station cannot be reached: nothing planned, the notes say why', async () => {
    const c2 = context({ root: T, isAgent: () => false, notify: () => true, call: async () => { throw new Error('ECONNREFUSED'); } });
    const r = await apply(c2, { dry: true }); assert.strictEqual(r.steps.length, 0); assert.ok(r.notes.filter(n => /ECONNREFUSED/.test(n)).length === 3);
  });
  await t('an env-locked computer-control backend is reported, not posted', async () => {
    const S2 = fakeStation({ backend: 'cua', envLocked: true, masterBypass: false });
    const r = await apply(context({ root: T, isAgent: () => false, notify: () => true, call: S2.call }), { dry: true });
    assert.ok(!r.steps.some(s => /computer control/.test(s.what)) && r.notes.some(n => /launch environment/.test(n)));
  });
  await t('show marks enforcement files that do not read the switch yet (wiredIn)', async () => {
    const s = show(context({ root: co.ROOT }));
    const db = s.guards.find(g => g.name === 'defaultBranch');
    assert.ok(Array.isArray(db.wiredIn) && db.enforcedIn.length === 3);
  });

  if (prevProv === undefined) delete process.env.PROVENANCE_ROOT; else process.env.PROVENANCE_ROOT = prevProv;
  try { fs.rmSync(T, { recursive: true, force: true }); } catch (_) {}
  return { out, bad };
}

/* ---------------- cli ---------------- */
function parse(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); if (['json', 'dry-run'].includes(k)) flags[k] = true; else flags[k] = argv[i + 1] !== undefined ? argv[++i] : ''; }
    else pos.push(a);
  }
  return { pos, flags };
}
if (require.main === module) {
  const { pos, flags } = parse(process.argv.slice(2));
  const cmd = pos.shift();
  const done = r => { console.log(JSON.stringify(r, null, 1)); process.exit(r.ok ? 0 : (r.code || 1)); };
  (async () => {
    const ctx = context();
    try {
      if (cmd === 'show' || !cmd) { const s = show(ctx); if (flags.json) { console.log(JSON.stringify(s, null, 1)); process.exit(0); } printShow(s); process.exit(0); }
      if (cmd === 'set') { if (pos.length !== 2) done(err(2, 'set <name> on|off --by <owner> [--why "..."]')); done(setOne(ctx, pos[0], pos[1], flags.by, flags.why)); }
      if (cmd === 'off-all') done(setAll(ctx, 'off', flags.by, flags.why, flags.confirm));
      if (cmd === 'on-all') done(setAll(ctx, 'on', flags.by, flags.why));
      if (cmd === 'sandbox') { if (pos[0] === 'detect') done(Object.assign({ ok: true }, detect(ctx))); done(setSandbox(ctx, pos[0], flags.by, flags.why)); }
      if (cmd === 'apply') done(await apply(ctx, { dry: !!flags['dry-run'], by: flags.by }));
      if (cmd === 'selftest') { const { out, bad } = await selftest(); for (const l of out) console.log(l); console.log(bad ? bad + ' FAILED' : 'all ' + out.length + ' checks passed'); process.exit(bad ? 1 : 0); }
      done(err(2, 'commands: show [--json], set <name> on|off --by <owner>, off-all --by <owner> --confirm "' + CONFIRM + '", on-all --by <owner>, sandbox on|off|detect, apply [--dry-run], selftest'));
    } catch (e) { done(err(e.code === 1 ? 1 : 1, String((e && e.message) || e))); }
  })();
}
module.exports = { show, setOne, setAll, setSandbox, detect, plan, apply, context, MAP, CONFIRM };
