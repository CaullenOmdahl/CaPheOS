'use strict';
// connector-scope.test.js — tests StarNet's own connector code for the two properties the GitHub scope relies on
// (company/work/security/external-capability-inventory.md):
//  1. a configured HTTP header reaches the server on EVERY request (initialize, tools/list, tools/call), and survives a
//     reconfigure that does not mention headers and a refresh;
//  2. a tool the server did not publish is refused by the manager before any request leaves the station.
// The fake server applies GitHub's documented X-MCP-Readonly rule (write tools are not registered).
// It copies the StarNet files it needs into a temporary folder and loads them from there: the live tree is only read.
//   node company/tools/tests/connector-scope.test.js        (then: node company/tools/connector-scope.js --selftest)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const co = require('../lib/company');
const SIDECAR = process.env.STARNET_SIDECAR || co.p('starnet', 'sidecar');   // env: test against another StarNet checkout
if (!fs.existsSync(SIDECAR)) { console.log('SKIP: no StarNet sidecar at ' + SIDECAR + ' (set STARNET_SIDECAR)'); process.exit(0); }
const FILES = ['context.js', 'failopen.js', 'mcp/client.js', 'mcp/manager.js', 'mcp/oauth-target.js', 'mcp/translate.js', 'tools/fence.js'];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-scope-test-'));
for (const f of FILES) { fs.mkdirSync(path.dirname(path.join(TMP, f)), { recursive: true }); fs.copyFileSync(path.join(SIDECAR, f), path.join(TMP, f)); }
let makeConnectorManager, sameEndpoint;
try {
  ({ makeConnectorManager } = require(path.join(TMP, 'mcp/manager.js')));
  ({ sameEndpoint } = require(path.join(TMP, 'mcp/oauth-target.js')));
} catch (e) { console.error('FAIL: StarNet\'s connector files no longer load from ' + FILES.join(', ') + ' (a StarNet update?): ' + e.message); process.exit(1); }

const ALL = ['add_comment_to_pending_review', 'add_issue_comment', 'add_reply_to_pull_request_comment', 'create_branch', 'create_or_update_file', 'create_pull_request', 'create_repository', 'delete_file', 'fork_repository', 'get_commit', 'get_file_contents', 'get_label', 'get_latest_release', 'get_me', 'get_release_by_tag', 'get_tag', 'get_team_members', 'get_teams', 'issue_read', 'issue_write', 'list_branches', 'list_commits', 'list_issue_fields', 'list_issue_types', 'list_issues', 'list_pull_requests', 'list_releases', 'list_repository_collaborators', 'list_tags', 'merge_pull_request', 'pull_request_read', 'pull_request_review_write', 'push_files', 'request_copilot_review', 'run_secret_scanning', 'search_code', 'search_commits', 'search_issues', 'search_pull_requests', 'search_repositories', 'search_users', 'sub_issue_write', 'ui_get', 'update_issue_comment', 'update_pull_request', 'update_pull_request_branch'];
const scope = require(path.resolve(__dirname, '..', 'connector-scope.js'));
const isRead = n => scope.isRead(scope.POLICY.github, n);
const seen = [];   // every request the fake server received: { method, tool, headers }

function fakeGithub(cfg) {
  let onMsg = null;
  const readonly = String((cfg.headers || {})['X-MCP-Readonly'] || '').toLowerCase() === 'true';
  const published = ALL.filter(n => !readonly || isRead(n));
  return {
    onMessage(cb) { onMsg = cb; },
    async send(m) {
      seen.push({ method: m.method, tool: m.params && m.params.name, headers: Object.assign({}, cfg.headers) });
      if (m.id == null) return;
      let result;
      if (m.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-github' } };
      else if (m.method === 'tools/list') result = { tools: published.map(n => ({ name: n, description: n, inputSchema: { type: 'object' }, annotations: { readOnlyHint: isRead(n) } })) };
      else if (m.method === 'tools/call') {
        if (published.indexOf(m.params.name) < 0) { setImmediate(() => onMsg({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'unknown tool' } })); return; }
        result = { content: [{ type: 'text', text: 'ok ' + m.params.name }] };
      } else result = {};
      setImmediate(() => onMsg({ jsonrpc: '2.0', id: m.id, result }));
    },
    close() {}
  };
}

(async () => {
  const mgr = makeConnectorManager({ makeTransport: fakeGithub, clock: { now: () => 1 } });
  // BEFORE: no header -> the full 46-tool set, merge included
  let r = await mgr.configure('github', { transport: 'http', url: 'https://api.githubcopilot.com/mcp', tokenProvider: async () => 'T' });
  assert.strictEqual(r.toolCount, 46);
  assert.ok(mgr.status('github').tools.includes('merge_pull_request'));
  assert.strictEqual(ALL.filter(n => !isRead(n)).length, 18, 'connector-scope.js counts the 18 writes as writes');

  // AFTER: X-MCP-Readonly: true -> only read tools are published
  r = await mgr.configure('github', { transport: 'http', url: 'https://api.githubcopilot.com/mcp', headers: { 'X-MCP-Readonly': 'true' } });
  const st = mgr.status('github');
  const writes = st.tools.filter(n => !isRead(n));
  assert.deepStrictEqual(writes, [], 'no write tool published under readonly');
  assert.strictEqual(st.toolCount, 28);
  assert.deepStrictEqual(st.headers, { 'X-MCP-Readonly': '<set>' }, 'status shows the header key, never echoes values');

  // the header rode every request of the new connection
  const afterIdx = seen.findIndex(s => s.headers['X-MCP-Readonly'] === 'true');
  assert.ok(afterIdx >= 0);
  assert.ok(seen.slice(afterIdx).every(s => s.headers['X-MCP-Readonly'] === 'true'));

  // a merge call is refused locally: no tools/call for it ever leaves the station
  const before = seen.length;
  await assert.rejects(() => mgr.call('github', 'merge_pull_request', { pullNumber: 1 }), /no longer published/);
  await assert.rejects(() => mgr.call('github', 'push_files', {}), /no longer published/);
  assert.strictEqual(seen.length, before, 'refused before any request');
  // the registry projection carries no write def either
  assert.ok(!mgr.toolDefsFor('github').some(d => /merge_pull_request|push_files|delete_file|create_repository|fork_repository/.test(d.name)));
  // a read still works and still carries the header
  const ok = await mgr.call('github', 'get_me', {});
  assert.ok(/ok get_me/.test(JSON.stringify(ok)));
  assert.strictEqual(seen[seen.length - 1].headers['X-MCP-Readonly'], 'true');

  // a later reconfigure that omits `headers` (a benign enable/label edit, a token refresh reconnect) keeps the header
  await mgr.configure('github', { transport: 'http', url: 'https://api.githubcopilot.com/mcp', label: 'GitHub', enabled: true });
  assert.deepStrictEqual(mgr.status('github').headers, { 'X-MCP-Readonly': '<set>' });
  assert.ok(!mgr.status('github').tools.includes('merge_pull_request'));
  await mgr.refresh('github');
  assert.ok(!mgr.status('github').tools.includes('merge_pull_request'));

  // why the header and not the /mcp/readonly URL: a different path is a different service to the upsert route, which
  // drops the OAuth grant, and the GitHub device sign-in rewrites url to the catalog endpoint while keeping headers
  assert.strictEqual(sameEndpoint('https://api.githubcopilot.com/mcp', 'https://api.githubcopilot.com/mcp/'), true);
  assert.strictEqual(sameEndpoint('https://api.githubcopilot.com/mcp', 'https://api.githubcopilot.com/mcp/readonly'), false);

  await mgr.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('PASS: header carried on every request (' + seen.length + ' requests), ' + writes.length + ' write tools published, merge/push refused locally, header survives reconfigure+refresh, URL variant would be a new service');
})().catch(e => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} console.error('FAIL:', e && e.stack || e); process.exit(1); });
