#!/usr/bin/env node
/* inbox-size-guard.test.js — an inbox past its size (or open-item) threshold is handed ONCE to its manager to triage;
 * never to the seat itself; again only after 50% growth.
 *   node --test company/tools/tests/inbox-size-guard.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { spawn, spawnSync } = require('child_process');
const life = require('../lib/temp-life');

const REPO = path.resolve(__dirname, '..', '..', '..');
const DISPATCH = path.join(REPO, 'company', 'tools', 'dispatch.js');
const MOCK = path.join(REPO, 'tests', 'mock-station.js');
const TOKEN = 'guard-test-token';
const TZ = 'UTC';
const SEATS = {
  agent: { name: 'Alex', functions: ['ceo'], loop: 'Founder loop', inbox: 'to-founder.md', manager: null, priority: 100 },
  sam: { name: 'Sam', loop: 'Sam loop', inbox: 'to-sam.md', manager: 'agent', priority: 90 },
};
const blk = (n, status) => '\n## 2026-11-0' + (1 + n % 9) + ' from Alex — task ' + n + '\n**Need:** do it\n**Status:** ' + status + '\n';
const many = (from, n, status) => Array.from({ length: n }, (_, i) => blk(from + i, status)).join('');

let mock = null, port = 0;
const roots = [];
test.before(async () => {
  const log = path.join(life.tmpDir('guard-mock-'), 'req.jsonl'); roots.push(path.dirname(log));
  mock = life.track(spawn(process.execPath, [MOCK, '--port', '0', '--token', TOKEN, '--log', log], { stdio: ['ignore', 'pipe', 'inherit'] }));
  port = await new Promise((res, rej) => { let d = ''; mock.stdout.on('data', c => { d += c; const m = /"port":(\d+)/.exec(d); if (m) res(Number(m[1])); }); mock.on('exit', c => rej(new Error('mock exited ' + c))); });
});
test.after(() => { try { mock.kill(); } catch (_) {} for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });

function company(samInbox) {
  const T = life.tmpDir('guard-co-'); roots.push(T);
  const w = (rel, data) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); };
  w('company/company.json', { name: 'Guard Test', owner: { name: 'Pat' }, timezone: TZ, station: { port, serviceName: 'guard-test' } });
  w('secrets/station-token', TOKEN + '\n');
  w('company/tools/loops.json', { agents: SEATS });
  w('company/work/ops/cadence.json', JSON.parse(fs.readFileSync(path.join(REPO, 'company', 'defaults', 'work', 'ops', 'cadence.json'), 'utf8')));
  w('company/work/finance/dispatch-budget.json', { dailyUsd: 10, perAgentUsd: 0, unmeteredProviders: ['claude-cli'] });
  w('company/state/governance.json', { categories: {} });
  w('company/owner/inbound.jsonl', '');
  w('.starnet-data/workspaces/runs.jsonl', '');
  w('company/work/handoffs/to-founder.md', '# Handoffs\n');
  w('company/work/handoffs/to-sam.md', '# Handoffs\n' + samInbox);
  const c = { T, w, r: rel => fs.readFileSync(path.join(T, rel), 'utf8') };
  c.tick = () => {
    const p = spawnSync(process.execPath, [DISPATCH], { cwd: T, encoding: 'utf8', timeout: 120000,
      env: Object.assign({}, process.env, { CAPHEOS_ROOT: T, STARNET_URL: 'http://127.0.0.1:' + port, CAPHEOS_TZ: TZ, DISPATCH_INBOX_GUARD_KB: '1024', DISPATCH_INBOX_GUARD_ITEMS: '30' }) });
    assert.equal(p.status, 0, (p.stdout || '') + (p.stderr || ''));
  };
  c.notes = () => (c.r('company/work/handoffs/to-founder.md').match(/inbox is \d+ KB/g) || []).length;
  return c;
}

test('under the threshold: nothing', () => {
  const c = company(many(0, 10, 'OPEN'));
  c.tick();
  assert.equal(c.notes(), 0);
});

test('over: one manager handoff with counts and oldest headings; the seat is not written to; no duplicate; growth re-notes', () => {
  const c = company(many(0, 31, 'OPEN') + many(100, 3, 'BLOCKED') + many(200, 2, 'DONE'));
  c.tick();
  assert.equal(c.notes(), 1);
  const mgr = c.r('company/work/handoffs/to-founder.md');
  assert.match(mgr, /\*\*Counts:\*\* 31 OPEN, 3 BLOCKED, 0 PARKED, 2 DONE;/);
  assert.match(mgr, /\*\*Oldest:\*\* .*task /);
  assert.doesNotMatch(c.r('company/work/handoffs/to-sam.md'), /Dispatcher/);
  assert.equal((c.r('company/work/dispatch-log.md').match(/INBOX SIZE to-sam\.md/g) || []).length, 1);
  c.tick();
  assert.equal(c.notes(), 1, 'second tick adds nothing');
  const sam = c.r('company/work/handoffs/to-sam.md');
  c.w('company/work/handoffs/to-sam.md', sam + many(300, 20, 'OPEN'));   // 34 -> 54 work items: +59%
  c.tick();
  assert.equal(c.notes(), 2, 'growth of 50% re-notes once');
  c.tick();
  assert.equal(c.notes(), 2);
});
