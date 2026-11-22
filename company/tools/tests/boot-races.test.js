#!/usr/bin/env node
/* boot-races.test.js — dispatcher-loop waits for station port before tick #1, and network services get After=network-online.target.
 *   node --test company/tools/tests/boot-races.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), net = require('net');
const life = require('../lib/temp-life');

test('dispatcher-loop waits for station TCP port before running tick #1', async () => {
  const DL = require('../dispatcher-loop.js');
  const T = life.tmpDir('boot-dl-');
  const server = net.createServer();
  let port = 0;
  try {
    // Pick a free port, close it, then re-open it 250ms later while dispatcher-loop is waiting
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
    await new Promise(r => server.close(r));

    const marker = path.join(T, 'ticked.txt');
    const fakeCmd = path.join(T, 'tick.js');
    fs.writeFileSync(fakeCmd, `require('fs').writeFileSync(${JSON.stringify(marker)}, String(Date.now()));\n`);

    const server2 = net.createServer();
    let openedAt = 0;
    const t = setTimeout(() => { server2.listen(port, '127.0.0.1', () => { openedAt = Date.now(); }); }, 250);
    const logs = [];
    try {
      const code = await DL.runLoop({
        cmd: fakeCmd,
        stateFile: path.join(T, 'dl.json'),
        stationUrl: 'http://127.0.0.1:' + port,
        readyWaitMs: 5000,
        maxTicks: 1,
        signals: false,
        sprintTick: null,
        tempo: () => ({ tickMin: 1, cooldownMin: 1, maxPerTick: 1, source: 'test' }),
        log: l => logs.push(l)
      });
      assert.equal(code, 0);
      assert.ok(openedAt > 0, 'station opened before tick');
      const tickedAt = Number(fs.readFileSync(marker, 'utf8'));
      assert.ok(tickedAt >= openedAt, 'tick #1 ran only after station started listening');
      assert.ok(logs.some(l => /waiting up to 5 s/.test(l)), logs.join('\n'));
    } finally {
      clearTimeout(t);
      await new Promise(r => server2.close(() => r()));
    }
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
});

test('service.js adds After=network-online.target for network-enabled services only', () => {
  const S = require('../service.js');
  const T = life.tmpDir('boot-svc-');
  try {
    const R = path.join(T, 'co');
    for (const d of ['company/state', 'company/tools', 'company/work/scripts', 'company/defaults/state', 'company/owner']) fs.mkdirSync(path.join(R, d), { recursive: true });
    fs.writeFileSync(path.join(R, 'company/company.json'), JSON.stringify({ name: 'Test Co', slug: 'testco', owner: { name: 'Pat' }, station: { serviceName: 'testco-station' } }));
    fs.writeFileSync(path.join(R, 'company/tools/loops.json'), JSON.stringify({ agents: { data: { name: 'Hollis' } } }));
    fs.writeFileSync(path.join(R, 'company/work/scripts/a.sh'), 'echo ok\n');
    const ctx = S.context({ root: R, memPlan: { defaultMax: '512M', ceiling: '4G' } });
    const netSpec = S.specOf(ctx, 'poller', { kind: 'service', exec: 'bash company/work/scripts/a.sh', why: 'polls external api', network: 'on' }, { resolve: false });
    const localSpec = S.specOf(ctx, 'local', { kind: 'service', exec: 'bash company/work/scripts/a.sh', why: 'runs locally only', network: 'none' }, { resolve: false });
    const uNet = S.render(ctx, netSpec)['testco-svc-poller.service'];
    const uLoc = S.render(ctx, localSpec)['testco-svc-local.service'];
    assert.match(uNet, /After=network-online\.target/);
    assert.match(uNet, /Wants=network-online\.target/);
    assert.doesNotMatch(uLoc, /network-online\.target/);
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
});
