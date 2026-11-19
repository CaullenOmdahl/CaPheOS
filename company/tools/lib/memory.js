'use strict';
/* lib/memory.js — how much memory this machine has, what the company may use of it, and what it uses now (docs/RETENTION.md
 * "Memory"). Pure apart from reading /proc, /sys and `systemctl --user show`; every reader is injectable (selftests).
 *
 *   const M = require('./lib/memory');
 *   M.host(o)                 { totalMB, availableMB, swapTotalMB, swapUsedMB, zram, tmpfsTmp: {sizeMB, usedMB}|null, oomd }
 *   M.settings(config)        company.json runtime.memory with its defaults { profile: auto|low|normal, keepFreeMB, visibleBrowser }
 *   M.profileOf(settings, host)   'low' | 'normal' (auto: low on a machine of 4.5 GB or less)
 *   M.plan({ totalMB, profile, keepFreeMB, companies })   every limit the company sets, from the machine's size (pure;
 *                             MB, rounded down to 64 MB where the spec says so): the machine minus what is kept free and
 *                             the system's share, split evenly across the companies on it (companies, default 1). The
 *                             table in docs/RETENTION.md is asserted by memory.test.js.
 *   M.companies({ root, config, unitDir })   the companies set up on this machine: this one, and every other whose station
 *                             unit (ExecStart sidecar/index.js, WorkingDirectory <root>/starnet) is enabled in the user's
 *                             unit dir and whose root holds company/company.json; each with its keepFreeMB (read only)
 *   M.share({ root, config, unitDir, supervisor })   { n, keepFreeMB, others }: under systemd the companies above and the
 *                             largest keepFreeMB any of them asks for (memory kept free is the machine's, not one
 *                             company's); in a container or without a supervisor this company alone
 *   M.units(config, root)     the unit names: <svc>, <svc>-console, <svc>-dispatch and the registered services
 *   M.usage(o)                per unit {currentMB, peakMB, highMB, maxMB, pid}, the company's browsers, its private temp dir
 *   M.sample(o)               one line in company/state/memory-samples.jsonl
 *   M.growth(samples, now)    units whose memory kept growing for 48 h without a restart
 *   M.parseMeminfo / parseSwaps / parseShow    the parsers (fixtures in the selftest)
 * Owner: the tools function.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MB = 1048576;
const floor64 = v => Math.floor(v / 64 + 1e-9) * 64;   // the epsilon: 0.7 * 46080 is 32255.999... in floating point
const LOW_AT_MB = 4608;   // 4.5 GB: auto is low at or below this

function parseMeminfo(text) {
  const kv = {};
  for (const l of String(text || '').split('\n')) { const m = /^(\w+(?:\(\w+\))?):\s+(\d+)/.exec(l); if (m) kv[m[1]] = Number(m[2]); }
  const kb = k => (kv[k] || 0) / 1024;
  const avail = kv.MemAvailable != null ? kb('MemAvailable') : kb('MemFree') + kb('Cached') + kb('Buffers');
  return { totalMB: Math.round(kb('MemTotal')), availableMB: Math.round(avail), swapTotalMB: Math.round(kb('SwapTotal')), swapUsedMB: Math.round(kb('SwapTotal') - kb('SwapFree')) };
}
function parseSwaps(text) {
  const devs = String(text || '').split('\n').slice(1).map(l => l.trim().split(/\s+/)).filter(f => f.length >= 4 && f[0]);
  return { devices: devs.map(f => ({ name: f[0], type: f[1], sizeMB: Math.round(Number(f[2]) / 1024), usedMB: Math.round(Number(f[3]) / 1024) })), zram: devs.some(f => /\/zram\d+$/.test(f[0])) };
}
// `systemctl --user show -p A -p B u1 u2`: blocks of key=value separated by a blank line, in the order the units were named
function parseShow(text) {
  const out = []; let cur = null;
  for (const l of String(text || '').split('\n')) {
    if (!l.trim()) { if (cur) { out.push(cur); cur = null; } continue; }
    const i = l.indexOf('='); if (i < 0) continue;
    (cur = cur || {})[l.slice(0, i)] = l.slice(i + 1);
  }
  if (cur) out.push(cur);
  return out;
}
const bytesMB = v => { const n = Number(v); return v == null || v === '' || v === '[not set]' || v === 'infinity' || !Number.isFinite(n) || n >= 2 ** 63 - 2 ** 10 || n < 0 ? null : Math.round(n / MB); };

function read(o, f) { try { return (o && o.read ? o.read(f) : fs.readFileSync(f, 'utf8')); } catch (_) { return null; } }

function host(o) {
  o = o || {};
  const mi = parseMeminfo(read(o, (o.proc || '/proc') + '/meminfo'));
  const sw = parseSwaps(read(o, (o.proc || '/proc') + '/swaps'));
  let tmpfsTmp = null;
  const mounts = read(o, (o.proc || '/proc') + '/mounts') || '';
  const isTmpfs = mounts.split('\n').some(l => { const f = l.split(' '); return f[1] === '/tmp' && f[2] === 'tmpfs'; });
  if (isTmpfs) {
    try {
      const s = o.statfs ? o.statfs('/tmp') : fs.statfsSync('/tmp');
      tmpfsTmp = { sizeMB: Math.round(s.blocks * s.bsize / MB), usedMB: Math.round((s.blocks - s.bfree) * s.bsize / MB) };
    } catch (_) { tmpfsTmp = { sizeMB: null, usedMB: null }; }
  }
  let oomd = false;
  if (o.oomd !== undefined) oomd = !!o.oomd;
  else {
    let sup = 'none'; try { sup = require('./host').supervisor(); } catch (_) {}
    if (sup === 'systemd') { try { oomd = execFileSync(o.systemctlBin || '/usr/bin/systemctl', ['--user', 'is-active', 'systemd-oomd'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'active'; } catch (_) { oomd = false; } }
    // systemd-oomd is a system service; the user manager only forwards to it. Its socket is the honest sign it runs.
    if (!oomd) { try { oomd = fs.existsSync('/run/systemd/io.systemd.ManagedOOM'); } catch (_) {} }
  }
  return Object.assign(mi, { zram: sw.zram, swaps: sw.devices, tmpfsTmp, oomd });
}

function settings(config) {
  const m = (config && config.runtime && config.runtime.memory) || {};
  const profile = ['auto', 'low', 'normal'].includes(m.profile) ? m.profile : 'auto';
  const k = Number(m.keepFreeMB);
  return { profile, keepFreeMB: Number.isFinite(k) && k > 0 ? Math.round(k) : 0, visibleBrowser: m.visibleBrowser === true };
}
function profileOf(s, h) {
  if (s && (s.profile === 'low' || s.profile === 'normal')) return s.profile;
  return h && Number(h.totalMB) > 0 && Number(h.totalMB) <= LOW_AT_MB ? 'low' : 'normal';
}

/* plan: the numbers every part uses. All MB. */
function plan(o) {
  o = o || {};
  const totalMB = Math.max(0, Number(o.totalMB) || 0);
  const keepFreeMB = Math.max(0, Number(o.keepFreeMB) || 0);
  const companies = Math.max(1, Math.min(32, Math.floor(Number(o.companies) || 1)));
  const profile = o.profile === 'low' || o.profile === 'normal' ? o.profile : profileOf({ profile: 'auto' }, { totalMB });
  const low = profile === 'low';
  const osReserve = low ? 400 : 1024;
  const raw = Math.floor((totalMB - keepFreeMB - osReserve) / companies);
  const budget = Math.max(1024, raw);
  const warnings = [];
  if (raw < 1024) warnings.push((companies > 1 ? 'shared with ' + (companies - 1) + ' other compan' + (companies > 2 ? 'ies' : 'y') + ' on this computer, ' : '') + 'what is kept free leaves the company less than 1 GB; it plans with 1 GB, so the computer may run short');
  const sHigh = floor64(low ? Math.max(700, 0.55 * budget) : 0.50 * budget);
  const sMax = floor64(low ? Math.max(900, 0.70 * budget) : 0.70 * budget);
  return {
    profile, totalMB, keepFreeMB, companies, osReserve, budget, warnings,
    station: { heapMB: low ? 384 : 1024, highMB: sHigh, maxMB: sMax, swapMaxMB: floor64(sMax * 0.5) },
    console: { heapMB: low ? 128 : 192, highMB: low ? 160 : 256, maxMB: low ? 300 : 512 },
    // the dispatcher's own heap plus the tools each tick runs as children (about 600 MB at their peak): High is above
    // that, or it is throttled every tick; under low systemd-oomd does not kill it (the drop-in turns it off), the kernel
    // still ends it before the station (OOMScoreAdjust 200 against 100)
    dispatcher: { heapMB: low ? 160 : 192, highMB: low ? 512 : 768, maxMB: low ? 768 : 1024, oomdKill: !low },
    services: { defaultMax: low ? '256M' : '512M', ceiling: low ? '1G' : '4G' },
    browsers: { privateMax: low ? 1 : 3, idleMin: low ? 5 : 15, lowMemFlags: low },
    agents: { maxConcurrent: low ? 2 : 0 },
    reaper: { everyMin: low ? 10 : 15, orphanMinAgeMin: low ? 10 : 30, strayMinAgeH: low ? 3 : 6, privateTempAgeH: 24, pressureTempAgeH: 6 },
    pressure: { belowMB: low ? Math.max(300, keepFreeMB + 256) : keepFreeMB + 256 },
  };
}

/* the companies on this machine (read only: unit files and each one's company.json) */
const realOr = p => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };
function companies(o) {
  o = o || {};
  const out = new Map();
  const self = o.root ? realOr(o.root) : null;
  if (self) out.set(self, { root: self, svc: svcOf(o.config), self: true, keepFreeMB: settings(o.config).keepFreeMB });
  const dir = o.unitDir; let names = [];
  if (dir) { try { names = fs.readdirSync(dir); } catch (_) {} }
  for (const n of names) {
    if (!/\.service$/.test(n)) continue;
    const f = path.join(dir, n); let t;
    try { const st = fs.statSync(f); if (!st.isFile() || st.size > 65536) continue; t = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    if (!/^ExecStart=.*\bsidecar\/index\.js\b/m.test(t)) continue;
    const wd = /^WorkingDirectory=(\/.+)\/starnet\/?\s*$/m.exec(t); if (!wd) continue;
    const r = realOr(wd[1]); if (out.has(r)) continue;
    if (!fs.existsSync(path.join(dir, 'default.target.wants', n))) continue;   // installed but not enabled: not running here
    let cfg = null; try { cfg = JSON.parse(fs.readFileSync(path.join(r, 'company', 'company.json'), 'utf8')); } catch (_) { continue; }
    out.set(r, { root: r, svc: n.replace(/\.service$/, ''), self: false, name: cfg && cfg.name ? String(cfg.name).slice(0, 80) : null, keepFreeMB: settings(cfg).keepFreeMB });
  }
  return [...out.values()];
}
function share(o) {
  o = o || {};
  const own = settings(o.config).keepFreeMB;
  if (o.supervisor !== 'systemd') return { n: 1, keepFreeMB: own, others: [] };
  const list = companies(o);
  const others = list.filter(c => !c.self);
  return { n: Math.max(1, list.length), keepFreeMB: Math.max(own, ...list.map(c => c.keepFreeMB || 0)), others: others.map(c => ({ root: c.root, svc: c.svc, name: c.name, keepFreeMB: c.keepFreeMB })) };
}
function svcOf(config) { return String((config && config.station && config.station.serviceName) || 'capheos-station'); }
function slugOf(config) { return String((config && (config.slug || config.shortName)) || 'company').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'company'; }
function units(config, root) {
  const svc = svcOf(config);
  const out = [{ name: svc + '.service', role: 'station' }, { name: svc + '-console.service', role: 'console' }, { name: svc + '-dispatch.service', role: 'dispatcher' }];
  if (root) {
    let doc = null; try { doc = JSON.parse(fs.readFileSync(path.join(root, 'company', 'state', 'services.json'), 'utf8')); } catch (_) {}
    for (const e of Object.values((doc && doc.services) || {})) if (e && e.unit && e.status === 'installed') out.push({ name: e.unit + '.service', role: 'service', service: e.name });
  }
  return out;
}

// a bounded walk: bytes on disk, stops at `cap` entries and says so
function dirSize(dir, cap) {
  cap = cap || 20000; let bytes = 0, n = 0; const stack = [dir];
  while (stack.length) {
    const q = stack.pop(); let st; try { st = fs.lstatSync(q); } catch (_) { continue; }
    bytes += st.isDirectory() ? 0 : st.blocks * 512;
    if (++n >= cap) return { bytes, more: true };
    if (st.isDirectory()) { try { for (const e of fs.readdirSync(q)) stack.push(path.join(q, e)); } catch (_) {} }
  }
  return { bytes, more: false };
}

function realSystemctl(args) {
  const bin = process.env.MEMORY_SYSTEMCTL || '/usr/bin/systemctl';
  try { return { code: 0, out: execFileSync(bin, ['--user'].concat(args), { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { code: typeof e.status === 'number' ? e.status : 1, out: String(e.stdout || ''), err: String(e.stderr || e.message || '').slice(0, 300) }; }
}

/* usage: one `systemctl --user show` call for every unit; the browsers from lib/owned.js (they may sit outside the unit) */
function usage(o) {
  o = o || {};
  const root = o.root;
  const config = o.config || {};
  const sup = o.supervisor || (() => { try { return require('./host').supervisor(); } catch (_) { return 'none'; } })();
  const out = { supervisor: sup, units: {}, browsers: { count: 0, mb: 0 }, tmp: null, totalMB: 0 };
  if (sup === 'container') {
    const cur = bytesMB(read(o, (o.cgroup || '/sys/fs/cgroup') + '/memory.current'));
    const max = bytesMB(String(read(o, (o.cgroup || '/sys/fs/cgroup') + '/memory.max') || '').trim());
    out.units.container = { currentMB: cur, maxMB: max, pid: null, role: 'container' };
    out.totalMB = cur || 0;
  } else if (sup === 'systemd') {
    const list = units(config, root);
    const sc = o.systemctl || realSystemctl;
    const r = sc(['show', '-p', 'Id', '-p', 'MemoryCurrent', '-p', 'MemoryPeak', '-p', 'MemoryHigh', '-p', 'MemoryMax', '-p', 'MainPID', '-p', 'ActiveState'].concat(list.map(u => u.name)));
    const blocks = parseShow(r.out);
    list.forEach((u, i) => {
      const b = blocks.find(x => x.Id === u.name) || blocks[i] || {};
      const row = { role: u.role, active: b.ActiveState === 'active', currentMB: bytesMB(b.MemoryCurrent), peakMB: bytesMB(b.MemoryPeak), highMB: bytesMB(b.MemoryHigh), maxMB: bytesMB(b.MemoryMax), pid: Number(b.MainPID) || null };
      if (u.service) row.service = u.service;
      out.units[u.name] = row;
      out.totalMB += row.currentMB || 0;
    });
  }
  if (root && o.browsers !== false) {
    try {
      const own = require('./owned');
      const b = own.browsers(own.context(Object.assign({ root, config }, o.ownedOpts || {})));   // a context, not bare options
      out.browsers = { count: b.length, mb: Math.round(b.reduce((s, x) => s + (x.pssMB || 0), 0)), outside: b.filter(x => !x.inUnit).length };
      // a browser outside every company unit is not in a unit's MemoryCurrent: add it to the total
      out.totalMB += Math.round(b.filter(x => !x.inUnit).reduce((s, x) => s + (x.pssMB || 0), 0));
    } catch (_) {}
  }
  if (root) {
    const d = path.join(root, '.starnet-data', 'tmp');
    if (fs.existsSync(d)) { const s = dirSize(d, o.tmpCap || 20000); out.tmp = { dir: d, mb: Math.round(s.bytes / MB), more: s.more }; }
  }
  return out;
}

function sampleFile(root) { return path.join(root, 'company', 'state', 'memory-samples.jsonl'); }
function sample(o) {
  o = o || {};
  const h = o.host || host(o.hostOpts);
  const u = o.usage || usage(o);
  const row = { at: new Date(Number.isFinite(o.now) ? o.now : Date.now()).toISOString(), host: { availableMB: h.availableMB, swapUsedMB: h.swapUsedMB }, units: {}, browsers: u.browsers, tmpMB: u.tmp ? u.tmp.mb : null };
  for (const [name, x] of Object.entries(u.units)) row.units[name] = { currentMB: x.currentMB, pid: x.pid };
  if (!o.dry && o.root) { const f = sampleFile(o.root); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify(row) + '\n'); }
  return row;
}
// the last `hours` of samples, read from the end of the file (lib/bounded.js when present)
function readSamples(root, hours, now) {
  const f = sampleFile(root); let text = '';
  try { const B = require('./bounded'); text = B.tailText ? B.tailText(f, 8 * MB) : fs.readFileSync(f, 'utf8'); } catch (_) { try { text = fs.readFileSync(f, 'utf8'); } catch (_) { return []; } }
  const since = (Number.isFinite(now) ? now : Date.now()) - (hours || 48) * 3600e3;
  return String(text).split('\n').map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(r => r && Date.parse(r.at) >= since);
}
const median = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
/* growth: per unit, over the last 48 h, with the same pid throughout (no restart): the median of the first 6 h against the
   median of the last 6 h. More than +50 % and more than +150 MB is growing. */
function growth(samples, now) {
  now = Number.isFinite(now) ? now : Date.now();
  const W = 48 * 3600e3, E = 6 * 3600e3, start = now - W;
  const rows = (samples || []).filter(s => s && Date.parse(s.at) >= start).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (!rows.length || Date.parse(rows[0].at) > start + E) return [];   // fewer than 48 h of samples: nothing to judge
  const names = new Set(); for (const r of rows) for (const n of Object.keys(r.units || {})) names.add(n);
  const out = [];
  for (const n of names) {
    const pts = rows.map(r => ({ t: Date.parse(r.at), mb: r.units[n] && r.units[n].currentMB, pid: r.units[n] && r.units[n].pid })).filter(p => Number.isFinite(p.mb));
    if (pts.length < 4) continue;
    if (new Set(pts.map(p => p.pid)).size !== 1 || !pts[0].pid) continue;   // restarted (or never running) inside the window
    const first = median(pts.filter(p => p.t < start + E).map(p => p.mb)), last = median(pts.filter(p => p.t >= now - E).map(p => p.mb));
    if (first == null || last == null) continue;
    const growing = last > first * 1.5 && last - first > 150;
    out.push({ unit: n, pid: pts[0].pid, firstMB: Math.round(first), lastMB: Math.round(last), growing });
  }
  return out.filter(x => x.growing);
}

module.exports = { companies, share, host, settings, profileOf, plan, units, usage, sample, readSamples, growth, parseMeminfo, parseSwaps, parseShow, bytesMB, dirSize, floor64, realSystemctl, svcOf, slugOf, LOW_AT_MB, sampleFile };
