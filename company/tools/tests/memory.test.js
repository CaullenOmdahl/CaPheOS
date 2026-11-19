'use strict';
// memory.test.js — lib/memory.js: the plan table (docs/RETENTION.md "Memory"), the automatic profile, a keep-free larger
// than the machine, the /proc parsers (zram too), the 48-hour growth check, a container's cgroup.
//   node --test company/tools/tests/memory.test.js
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('assert');
const life = require('../lib/temp-life');
const M = require('../lib/memory');

const row = (totalMB, profile, keepFreeMB) => { const p = M.plan({ totalMB, profile, keepFreeMB }); return [p.station.highMB, p.station.maxMB, p.console.highMB, p.console.maxMB, p.dispatcher.highMB, p.dispatcher.maxMB, p.browsers.privateMax, p.browsers.idleMin]; };

test('the plan table: MemoryHigh / MemoryMax per unit, browsers at once and idle minutes', () => {
  assert.deepStrictEqual(row(2048, 'low', 0), [896, 1152, 160, 300, 512, 768, 1, 5]);
  assert.deepStrictEqual(row(4096, 'low', 0), [1984, 2560, 160, 300, 512, 768, 1, 5]);
  assert.deepStrictEqual(row(8192, 'normal', 0), [3584, 4992, 256, 512, 768, 1024, 3, 15]);
  assert.deepStrictEqual(row(16384, 'normal', 6144), [4608, 6400, 256, 512, 768, 1024, 3, 15]);
  assert.deepStrictEqual(row(63488, 'normal', 16384), [23040, 32256, 256, 512, 768, 1024, 3, 15]);
  const low = M.plan({ totalMB: 2048, profile: 'low' });
  assert.strictEqual(low.station.heapMB, 384); assert.strictEqual(low.station.swapMaxMB, 576);
  assert.strictEqual(low.services.defaultMax, '256M'); assert.strictEqual(low.services.ceiling, '1G');
  assert.strictEqual(low.agents.maxConcurrent, 2); assert.strictEqual(low.reaper.everyMin, 10); assert.strictEqual(low.browsers.lowMemFlags, true);
  const n = M.plan({ totalMB: 63488, profile: 'normal' });
  assert.strictEqual(low.dispatcher.oomdKill, false, 'low: no systemd-oomd kill for the dispatcher'); assert.ok(low.dispatcher.highMB > low.dispatcher.heapMB + 256, 'low: the dispatcher\'s High leaves room for its ticks\' children'); assert.strictEqual(n.dispatcher.oomdKill, true);
  assert.strictEqual(n.agents.maxConcurrent, 0); assert.strictEqual(n.services.ceiling, '4G'); assert.strictEqual(n.reaper.everyMin, 15);
});

test('auto is low at 4.5 GB and normal at 4.6 GB; an explicit profile wins', () => {
  assert.strictEqual(M.profileOf({ profile: 'auto' }, { totalMB: 4608 }), 'low');
  assert.strictEqual(M.profileOf({ profile: 'auto' }, { totalMB: 4710 }), 'normal');
  assert.strictEqual(M.profileOf({ profile: 'normal' }, { totalMB: 2048 }), 'normal');
  assert.strictEqual(M.profileOf({ profile: 'low' }, { totalMB: 63488 }), 'low');
  assert.deepStrictEqual(M.settings({}), { profile: 'auto', keepFreeMB: 0, visibleBrowser: false });
  assert.deepStrictEqual(M.settings({ runtime: { memory: { profile: 'tiny', keepFreeMB: -5, visibleBrowser: 'yes' } } }), { profile: 'auto', keepFreeMB: 0, visibleBrowser: false }, 'bad values fall back');
});

test('keeping free more than the machine has: the budget floors at 1 GB, with a warning', () => {
  const p = M.plan({ totalMB: 4096, profile: 'normal', keepFreeMB: 8192 });
  assert.strictEqual(p.budget, 1024); assert.ok(p.warnings.length === 1 && /less than 1 GB/.test(p.warnings[0]));
  assert.strictEqual(M.plan({ totalMB: 63488, profile: 'normal', keepFreeMB: 0 }).warnings.length, 0);
});

test('/proc/meminfo and /proc/swaps parsers, zram included; systemctl show blocks', () => {
  const mi = M.parseMeminfo('MemTotal:       65011712 kB\nMemFree:  1000 kB\nMemAvailable:   37748736 kB\nSwapTotal:      67108864 kB\nSwapFree:       31457280 kB\n');
  assert.deepStrictEqual(mi, { totalMB: 63488, availableMB: 36864, swapTotalMB: 65536, swapUsedMB: 34816 });
  const sw = M.parseSwaps('Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n/dev/zram0                              partition\t33554428\t1048576\t\t100\n/swapfile file 33554428 0 -2\n');
  assert.strictEqual(sw.zram, true); assert.strictEqual(sw.devices.length, 2); assert.strictEqual(sw.devices[0].usedMB, 1024);
  assert.strictEqual(M.parseSwaps('Filename Type Size Used Priority\n/swapfile file 100 0 -2\n').zram, false);
  const show = M.parseShow('Id=a.service\nMemoryCurrent=1048576\nMemoryMax=infinity\n\nId=b.service\nMemoryCurrent=[not set]\n');
  assert.strictEqual(show.length, 2); assert.strictEqual(M.bytesMB(show[0].MemoryCurrent), 1); assert.strictEqual(M.bytesMB(show[0].MemoryMax), null); assert.strictEqual(M.bytesMB(show[1].MemoryCurrent), null);
  const h = M.host({ read: f => /meminfo$/.test(f) ? 'MemTotal: 2097152 kB\nMemAvailable: 1048576 kB\n' : /swaps$/.test(f) ? 'Filename Type Size Used Priority\n/dev/zram0 partition 1000 0 1\n' : /mounts$/.test(f) ? 'tmpfs /tmp tmpfs rw 0 0\n' : null,
    statfs: () => ({ blocks: 1024, bfree: 512, bsize: 1048576 }), oomd: true });
  assert.strictEqual(h.totalMB, 2048); assert.strictEqual(h.zram, true); assert.deepStrictEqual(h.tmpfsTmp, { sizeMB: 1024, usedMB: 512 }); assert.strictEqual(h.oomd, true);
});

test('growth over 48 h: flat is fine, growing is flagged, a restart in the middle is not growing', () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  const series = (fn, pidAt) => { const out = []; for (let h = 48; h >= 0; h -= 1) { const t = now - h * 3600e3; out.push({ at: new Date(t).toISOString(), units: { 's.service': { currentMB: fn(48 - h), pid: pidAt ? pidAt(48 - h) : 100 } } }); } return out; };
  assert.deepStrictEqual(M.growth(series(() => 900), now), []);
  const g = M.growth(series(i => 600 + i * 20), now);
  assert.strictEqual(g.length, 1); assert.strictEqual(g[0].unit, 's.service'); assert.ok(g[0].lastMB - g[0].firstMB > 150);
  assert.deepStrictEqual(M.growth(series(i => 600 + i * 20, i => i < 24 ? 100 : 200), now), [], 'restarted inside the window');
  assert.deepStrictEqual(M.growth(series(i => 600 + i * 2), now), [], 'a small rise (under +50 % / +150 MB) is not growing');
  assert.deepStrictEqual(M.growth(series(i => 600 + i * 20).slice(30), now), [], 'fewer than 48 h of samples: nothing judged');
});

test('a container: the whole container\'s cgroup is the company\'s use', () => {
  const T = life.tmpDir('memory-test-selftest-');
  fs.writeFileSync(path.join(T, 'memory.current'), String(700 * 1048576)); fs.writeFileSync(path.join(T, 'memory.max'), String(3 * 1024 * 1048576));
  const u = M.usage({ supervisor: 'container', cgroup: T, browsers: false });
  assert.deepStrictEqual(u.units.container, { currentMB: 700, maxMB: 3072, pid: null, role: 'container' });
  assert.strictEqual(u.totalMB, 700);
});

test('units: the three company units and the installed registered services', () => {
  const T = life.tmpDir('memory-units-selftest-');
  fs.mkdirSync(path.join(T, 'company', 'state'), { recursive: true });
  fs.writeFileSync(path.join(T, 'company', 'state', 'services.json'), JSON.stringify({ services: { rec: { name: 'rec', unit: 'co-svc-rec', status: 'installed' }, old: { name: 'old', unit: 'co-svc-old', status: 'removed' } } }));
  assert.deepStrictEqual(M.units({ station: { serviceName: 'co-station' } }, T).map(u => u.name), ['co-station.service', 'co-station-console.service', 'co-station-dispatch.service', 'co-svc-rec.service']);
});

test('status reads the station browser (GET /api/browser/view) and never fails without a station', async () => {
  const T = life.tmpDir('memory-station-test-');
  fs.mkdirSync(path.join(T, 'company', 'state'), { recursive: true });
  fs.writeFileSync(path.join(T, 'company', 'company.json'), JSON.stringify({ name: 'S', slug: 's', station: { serviceName: 's-station', port: 1 } }));
  const MJ = require('../memory');
  const seen = [];
  const base = { root: T, supervisor: 'none', host: { totalMB: 8192, availableMB: 4096, swapTotalMB: 0, swapUsedMB: 0 }, systemctl: () => ({ code: 1, out: '' }) };
  const open = await MJ.statusWithStation(MJ.context(Object.assign({}, base, { stationApi: async (m, p) => { seen.push(m + ' ' + p); return { ok: true, station: { open: true, mode: 'builtin', visible: false, driver: null } }; } })));
  assert.deepStrictEqual(seen, ['GET /api/browser/view']);
  assert.deepStrictEqual(open.station.browser, { open: true, driver: null, mode: 'builtin', visible: false });
  const driven = await MJ.stationBrowser(MJ.context(Object.assign({}, base, { stationApi: async () => ({ station: { open: true, driver: { agentId: 'phil', runId: 'r1' } } }) })));
  assert.strictEqual(driven.driver, 'phil');
  const off = await MJ.stationBrowser(MJ.context(Object.assign({}, base, { noNetwork: true })));
  assert.ok(off.unknown && /no network/.test(off.unknown), JSON.stringify(off));
  life.cleanup();
});
