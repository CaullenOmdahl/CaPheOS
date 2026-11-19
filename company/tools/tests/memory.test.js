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
  assert.deepStrictEqual(row(2048, 'low', 0), [1152, 1152, 160, 300, 512, 768, 1, 5]);
  assert.deepStrictEqual(row(4096, 'low', 0), [2560, 2560, 160, 300, 512, 768, 1, 5]);
  assert.deepStrictEqual(row(8192, 'normal', 0), [4992, 4992, 256, 512, 768, 1024, 3, 15]);
  assert.deepStrictEqual(row(16384, 'normal', 6144), [6400, 6400, 256, 512, 768, 1024, 3, 15]);
  assert.deepStrictEqual(row(63488, 'normal', 16384), [32256, 32256, 256, 512, 768, 1024, 3, 15]);
  const low = M.plan({ totalMB: 2048, profile: 'low' });
  assert.strictEqual(low.station.heapMB, 384); assert.strictEqual(low.station.swapMaxMB, 128);
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
  const driven = await MJ.stationBrowser(MJ.context(Object.assign({}, base, { stationApi: async () => ({ station: { open: true, driver: { agentId: 'paul', runId: 'r1' } } }) })));
  assert.strictEqual(driven.driver, 'paul');
  const off = await MJ.stationBrowser(MJ.context(Object.assign({}, base, { noNetwork: true })));
  assert.ok(off.unknown && /no network/.test(off.unknown), JSON.stringify(off));
  life.cleanup();
});

test('two companies on one machine: each plans with an even share after what is kept free; together they fit', () => {
  const one = M.plan({ totalMB: 63488, profile: 'normal', keepFreeMB: 0 });
  const two = M.plan({ totalMB: 63488, profile: 'normal', keepFreeMB: 0, companies: 2 });
  assert.strictEqual(one.companies, 1); assert.strictEqual(two.companies, 2);
  assert.strictEqual(two.budget, Math.floor((63488 - 1024) / 2));
  const fixed = p => p.console.maxMB + p.dispatcher.maxMB;
  assert.ok(2 * (two.station.maxMB + fixed(two)) <= 63488 - two.osReserve, 'both stations at their hard limit still fit: ' + two.station.maxMB);
  assert.ok(one.station.maxMB + fixed(one) > (63488 - 1024) / 2, 'alone, one company may use more than half');
  const kept = M.plan({ totalMB: 63488, profile: 'normal', keepFreeMB: 16384, companies: 2 });
  assert.strictEqual(kept.budget, Math.floor((63488 - 16384 - 1024) / 2));
  assert.ok(/shared with 1 other company/.test(M.plan({ totalMB: 4096, profile: 'normal', companies: 2, keepFreeMB: 2048 }).warnings[0] || ''));
});

test('companies on this machine: enabled station units with a company folder; share takes the largest keep-free', () => {
  const T = life.tmpDir('memory-test-selftest-');
  const U = path.join(T, 'units'); fs.mkdirSync(path.join(U, 'default.target.wants'), { recursive: true });
  const co = (name, keep) => { const r = path.join(T, name); fs.mkdirSync(path.join(r, 'company'), { recursive: true }); fs.writeFileSync(path.join(r, 'company', 'company.json'), JSON.stringify({ name: name.toUpperCase(), station: { serviceName: name + '-station' }, runtime: keep ? { memory: { keepFreeMB: keep } } : {} })); return r; };
  const unit = (svc, r, enabled) => { const f = path.join(U, svc + '.service'); fs.writeFileSync(f, '[Unit]\nDescription=StarNet station — x\n[Service]\nWorkingDirectory=' + r + '/starnet\nExecStart=/usr/bin/env node sidecar/index.js\n'); if (enabled) fs.symlinkSync(f, path.join(U, 'default.target.wants', svc + '.service')); };
  const a = co('aa'), b = co('bb', 8192), c = co('cc', 30000), gone = path.join(T, 'old');
  unit('aa-station', a, true); unit('bb-station', b, true); unit('cc-station', c, false); unit('old-station', gone, true);
  fs.writeFileSync(path.join(U, 'aa-station-console.service'), '[Service]\nWorkingDirectory=' + a + '\nExecStart=/usr/bin/env node ' + a + '/console/server.js\n');
  fs.symlinkSync(path.join(U, 'aa-station-console.service'), path.join(U, 'default.target.wants', 'aa-station-console.service'));
  const cfgA = JSON.parse(fs.readFileSync(path.join(a, 'company', 'company.json'), 'utf8'));
  const list = M.companies({ root: a, config: cfgA, unitDir: U });
  assert.deepStrictEqual(list.map(x => path.basename(x.root)).sort(), ['aa', 'bb'], 'cc is not enabled; old has no company folder; a console unit is not a station');
  const sh = M.share({ root: a, config: cfgA, unitDir: U, supervisor: 'systemd' });
  assert.strictEqual(sh.n, 2); assert.strictEqual(sh.keepFreeMB, 8192, 'the machine keeps free what any company on it asks for'); assert.deepStrictEqual(sh.others.map(o => o.name), ['BB']);
  assert.deepStrictEqual(M.share({ root: a, config: cfgA, unitDir: U, supervisor: 'container' }), { n: 1, keepFreeMB: 0, others: [] }, 'a container is one company');
  assert.strictEqual(M.companies({ root: a, config: cfgA, unitDir: path.join(T, 'none') }).length, 1, 'no unit dir: this company alone');
  life.cleanup();
});

test('usage counts the company\'s browsers (lib/owned.js on a fake /proc), outside a unit added to the total', () => {
  const T = life.tmpDir('memory-usage-selftest-');
  const root = path.join(T, 'co'), proc = path.join(T, 'proc');
  fs.mkdirSync(path.join(root, 'company'), { recursive: true }); fs.mkdirSync(proc);
  fs.writeFileSync(path.join(root, 'company', 'company.json'), JSON.stringify({ slug: 'co', station: { serviceName: 'co-station' } }));
  fs.writeFileSync(path.join(proc, 'stat'), 'cpu 0\nbtime ' + Math.floor(Date.now() / 1000 - 3600) + '\n');
  const put = (pid, ppid, comm, cmd) => { const d = path.join(proc, String(pid)); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'cmdline'), cmd.join('\0') + '\0');
    fs.writeFileSync(path.join(d, 'stat'), pid + ' (' + comm + ') S ' + ppid + ' ' + pid + ' 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 100 0');
    fs.writeFileSync(path.join(d, 'status'), 'Name:\t' + comm + '\nUid:\t' + process.getuid() + '\t0\t0\t0\nVmRSS:\t  102400 kB\n'); };
  put(1058, 1, 'systemd', ['/usr/lib/systemd/systemd', '--user']);
  put(70, 1058, 'chrome', ['/opt/google/chrome/chrome', '--headless', '--remote-debugging-port=9700', '--user-data-dir=' + root + '/.starnet-data/tmp/p']);
  const u = M.usage({ root, config: {}, supervisor: 'none', ownedOpts: { proc, cgroupOf: () => '', netTcp: '' } });
  assert.deepStrictEqual(u.browsers, { count: 1, mb: 100, outside: 1 });
  assert.strictEqual(u.totalMB, 100, 'a browser outside every unit adds to the total');
  life.cleanup();
});

test('the company\'s own slice: outside app.slice, every level named, pressure kill off on each (generated units)', () => {
  // the two shapes on this machine: a name that starts with capheos-, and one that does not (with dashes: levels)
  assert.strictEqual(M.sliceOf({ station: { serviceName: 'capheos-trial-station' } }), 'capheos-trial-station.slice');
  assert.strictEqual(M.sliceOf({ station: { serviceName: 'dev-co-station' } }), 'capheos-dev-co-station.slice');
  assert.strictEqual(M.sliceOf({}), 'capheos-station.slice', 'the default service name');
  assert.strictEqual(M.sliceOf({ station: { serviceName: 'odd name--x.service' } }), 'capheos-odd_name-x.slice', 'no space, no empty level');
  assert.deepStrictEqual(M.sliceChain('capheos-dev-co-station.slice'), ['capheos.slice', 'capheos-dev.slice', 'capheos-dev-co.slice', 'capheos-dev-co-station.slice']);
  for (const s of ['capheos-trial-station.slice', 'capheos-dev-co-station.slice']) assert.ok(!M.sliceChain(s).includes('app.slice') && M.sliceChain(s)[0] === 'capheos.slice', 'a top-level slice of its own, never app.slice');

  // memory.js apply's slice files: a unit for the slice, and the drop-in on it and every level above it
  const T = life.tmpDir('memory-slice-test-');
  const MJ = require('../memory.js');
  const ctx = MJ.context({ root: T, unitDir: path.join(T, 'units'), supervisor: 'systemd', host: { totalMB: 8192 }, accept: () => {}, systemctl: () => ({ code: 0, out: '' }) });
  ctx.config = { name: 'CPD', station: { serviceName: 'dev-co-station' } };
  const files = MJ.sliceFiles(ctx);
  const rel = Object.keys(files).map(f => path.relative(ctx.unitDir, f)).sort();
  assert.deepStrictEqual(rel, ['capheos-dev-co-station.slice', 'capheos-dev-co-station.slice.d/50-capheos-memory.conf', 'capheos-dev-co.slice.d/50-capheos-memory.conf',
    'capheos-dev.slice.d/50-capheos-memory.conf', 'capheos.slice.d/50-capheos-memory.conf'].sort());
  for (const [f, t] of Object.entries(files)) {
    if (/\.d\//.test(f)) assert.ok(/\n\[Slice\]\nManagedOOMMemoryPressure=auto\n$/.test(t) && !/=kill/.test(t), f + ': ' + t);
    else assert.ok(/^\[Unit\]\nDescription=CPD: /m.test(t) && !/ManagedOOM/.test(t), 'the slice unit only names it; the drop-in (50- sorts after the host\'s 10-) sets it');
  }
  // the shared top level reads the same from every company, so two companies never fight over it
  const ctx2 = Object.assign({}, ctx, { config: { name: 'Sandbox', station: { serviceName: 'trial-co-station' } } });
  const top = f => Object.entries(f).find(([k]) => k.endsWith(path.join('capheos.slice.d', '50-capheos-memory.conf')))[1];
  assert.strictEqual(top(files), top(MJ.sliceFiles(ctx2)));

  // the templates: every service unit says Slice=@SLICE@ in [Service]; rendered the way scripts/setup-station.sh does, no
  // placeholder is left and the station keeps MemoryHigh-before-MemoryMax (drop-in), OOMPolicy=continue and omit
  const sysd = path.join(__dirname, '..', '..', '..', 'systemd');
  const setup = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'scripts', 'setup-station.sh'), 'utf8');
  assert.ok(/-e "s\|@SLICE@\|\$SLICE\|g"/.test(setup) && /SLICE="\$\(node -e .*sliceOf\(require\('\.\/company\/company\.json'\)\)/.test(setup), 'setup-station.sh fills @SLICE@ from lib/memory.js sliceOf');
  const subs = { ROOT: '/srv/co', SVC: 'dev-co-station', NAME: 'CPD', ENVFILE: '/home/u/.config/x.env', TICK: '10', SLICE: M.sliceOf(ctx.config) };
  const services = fs.readdirSync(sysd).filter(f => /\.service\.in$/.test(f));
  assert.ok(services.length >= 5, services.join());
  for (const f of services) {
    const t = fs.readFileSync(path.join(sysd, f), 'utf8');
    const svcSec = t.slice(t.indexOf('[Service]'), t.indexOf('[Install]') > 0 ? t.indexOf('[Install]') : undefined);
    assert.strictEqual((svcSec.match(/^Slice=@SLICE@$/mg) || []).length, 1, f + ': one Slice=@SLICE@ in [Service]');
    const out = t.replace(/@(\w+)@/g, (m, k) => subs[k] != null ? subs[k] : m);
    assert.ok(!/@[A-Z]+@/.test(out), f + ': a placeholder setup-station.sh does not fill');
    assert.ok(/^Slice=capheos-dev-co-station\.slice$/m.test(out), f);
  }
  const st = fs.readFileSync(path.join(sysd, 'capheos-station.service.in'), 'utf8');
  assert.ok(/^OOMPolicy=continue$/m.test(st) && /^ManagedOOMPreference=omit$/m.test(st));
  const d = MJ.dropins(Object.assign({}, ctx, { root: path.join(__dirname, '..', '..', '..') }), MJ.planFor(ctx));
  assert.ok(/\nMemoryHigh=\d+M\nMemoryMax=\d+M\n/.test(d['dev-co-station.service'].text), 'MemoryHigh before MemoryMax');
  life.cleanup();
});
