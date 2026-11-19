#!/usr/bin/env node
/* connector-scope.js — is every StarNet connector still inside the scope the risk owner's inventory records for it?
 *
 * Why: the GitHub connector runs on the owner's account with an OAuth token whose scope is `repo read:org` (full write), and StarNet (v0.15.x) gives every
 * Full Access agent every connector tool with no prompt. StarNet has no per-tool or per-agent connector switch, so the
 * scope is set at GitHub's side: the connector sends `X-MCP-Readonly: true`, and GitHub's MCP server then publishes
 * read tools only. StarNet refuses a call to any tool the server did not publish (sidecar/mcp/manager.js:588), so a
 * write tool cannot be reached from a run. The header is a station setting that anyone holding the station token can
 * change, so this tool reads what the station is publishing NOW and says when it moved.
 *
 *   node company/tools/connector-scope.js              exit 0 = every connector in scope, 1 = drift, 2 = station unreadable,
 *                                                      3 = no drift seen, but a connector could not be verified
 *   node company/tools/connector-scope.js --json       same verdict as JSON
 *   node company/tools/connector-scope.js --selftest   fixtures
 *   node company/tools/connector-scope.js --duty       read-only duty check (docs/DUTIES.md) with NO station call and no
 *                                                      token: the saved policy header of each policy connector, and the drift
 *                                                      locked-watch.js has flagged and not yet seen cleared (its baseline).
 *                                                      exit 0 = none, 1 = JSON {due, reason, key, items} (ids only)
 *
 * What it reads (changes nothing):
 *   - GET /api/connectors: ids, state, enabled, url, header KEYS and tool names (the station masks header values);
 *   - GET /api/servicekeys: ids, names and env-var names only (a GitHub key there reaches every agent's shell);
 *   - the station's saved connector config (.starnet-data/workspaces/connectors/state.json), for ONE thing only: whether
 *     the policy header's saved value is exactly "true". That file also holds OAuth tokens; nothing else is read out of
 *     it and no value is ever printed. An encrypted store is not decrypted: the value then counts as unknown.
 * A connector that is down, disabled or still signing in lists no tools. Then the saved header value is what is checked;
 * if that cannot be read either, the verdict is UNVERIFIED (exit 3), never OK.
 * Wired: company/tools/locked-watch.js runs judge() on every dispatcher tick and reports drift to the risk owner once per change.
 * Owner: the risk seat (policy, external-capability-inventory.md), the tools seat (this tool).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const co = require('./lib/company');
const ROOT = path.resolve(process.env.CONNECTOR_SCOPE_ROOT || co.ROOT);   // env only for tests
const STATION = process.env.CONNECTOR_SCOPE_URL || co.STATION_URL;          // env only for tests
const STATE_FILE = () => path.join(ROOT, '.starnet-data', 'workspaces', 'connectors', 'state.json');
const INVENTORY = 'company/work/security/external-capability-inventory.md';

// One row per connector the inventory allows. A connector that is not here is drift until the risk owner adds a row.
const POLICY = {
  github: {
    url: 'https://api.githubcopilot.com/mcp',
    header: 'X-MCP-Readonly', value: 'true',
    // 'any' today: the OAuth device sign-in (token scope repo read:org, full write; the header is what keeps it read-only).
    // 'token' once the owner switches the connector to a fine-grained read-only token:
    // then an OAuth sign-in from the APPS panel, which would bring a full-write token back, counts as drift.
    auth: 'any',
    // GitHub's read tools: get_/list_/search_ prefixes and *_read, minus any name that starts with a write verb
    // (mark_all_notifications_read is a write), plus the two read tools with other names that GitHub publishes in
    // read-only mode. Anything else counts as a write.
    read: /^(get_|list_|search_)|_read$/,
    readNames: ['ui_get', 'run_secret_scanning'],
    writeVerb: /^(add|approve|archive|assign|cancel|close|create|delete|disable|dismiss|enable|fork|lock|manage|mark|merge|push|remove|reopen|request|rerun|resolve|run|set|star|submit|transfer|unlock|unstar|update|upload|write)_/,
    restore: enabled => 'POST /api/connectors {"id":"github","enabled":' + (enabled === false ? 'false' : 'true') + ',"headers":{"X-MCP-Readonly":"true"}} with the station token, then node company/tools/connector-scope.js (' + INVENTORY + ')'
  }
};
// GitHub credentials that reach agents' shells through the station's KEYS tab (servicekeys-catalog.js: GITHUB_API_KEY)
const GITHUB_SERVICE_KEY = k => /github/i.test(String(k.id || '') + ' ' + String(k.name || '')) || /^(GH|GITHUB)_/i.test(String(k.envVar || ''));

const isRead = (p, n) => p.readNames.includes(n) || (p.read.test(n) && !p.writeVerb.test(n));

/* list = /api/connectors .connectors; extra.headerValue = { id: true | false | null } (saved value is exactly the policy
   value / is not / unknown); extra.serviceKeys = /api/servicekeys .keys, or null when not read */
function judge(list, extra) {
  extra = extra || {};
  const hv = extra.headerValue || {};
  const out = { ok: true, drift: false, unverified: false, connectors: [], serviceKeys: [], notes: [] };
  for (const c of (list || [])) {
    const p = POLICY[c.id];
    const tools = Array.isArray(c.tools) ? c.tools : [];
    const up = c.state === 'up' && c.enabled !== false;
    const row = { id: c.id, state: c.state, enabled: c.enabled !== false, toolCount: tools.length, status: 'ok', problems: [], note: '' };
    if (!p) row.problems.push('not in the inventory: add a row to ' + INVENTORY + ' and a policy entry here, or remove it');
    else {
      if (String(c.url || '').replace(/\/+$/, '') !== p.url) row.problems.push('url is ' + (c.url || '(none)') + ', expected ' + p.url);
      const keys = Object.keys(c.headers || {});
      if (!keys.some(k => k.toLowerCase() === p.header.toLowerCase())) row.problems.push('header ' + p.header + ' is not set');
      else if (hv[c.id] === false) row.problems.push('header ' + p.header + ' is set, but its saved value is not "' + p.value + '"');
      if (p.auth === 'token' && c.oauth === true) row.problems.push('signed in with OAuth (a full-write token); the policy expects the read-only token (see ' + INVENTORY + ')');
      const writes = tools.filter(n => !isRead(p, n));
      if (writes.length) row.problems.push('publishes ' + writes.length + ' non-read tool(s): ' + writes.slice(0, 12).join(', ') + (writes.length > 12 ? ', ...' : ''));
      if (!row.problems.length) {
        const saved = hv[c.id] === true ? 'its saved ' + p.header + ' is "' + p.value + '"' : null;
        if (up && tools.length) row.note = 'read tools only' + (saved ? '; ' + saved : '; ' + p.header + ' is set (saved value not readable)');
        else {
          const why = c.enabled === false ? 'disabled' : c.state === 'up' ? 'up, but it lists no tools' : String(c.state || 'unknown state');
          if (saved) row.note = 'not serving tools now (' + why + '), so it gives agents none; ' + saved + ', and the tool list is checked again when it serves';
          else { row.status = 'unverified'; row.note = 'not serving tools now (' + why + ') and the saved value of ' + p.header + ' cannot be read: what it will publish when it serves again is not known'; }
        }
      }
      if (row.problems.length || row.status === 'unverified') row.restore = p.restore(c.enabled);
    }
    if (row.problems.length) row.status = 'drift';
    out.connectors.push(row);
  }
  if (Array.isArray(extra.serviceKeys)) {
    for (const k of extra.serviceKeys) {
      if (!GITHUB_SERVICE_KEY(k)) continue;
      const row = { id: 'servicekey:' + (k.id || k.name), envVar: k.envVar || '', enabled: k.enabled !== false, status: 'ok', problems: [], note: '' };
      if (row.enabled) { row.status = 'drift'; row.problems.push('a GitHub service key (' + (k.envVar || 'env var') + ') reaches every agent\'s shell; it is not in the inventory'); row.restore = 'the owner removes or disables it in the station (KEYS), or the risk owner records it in ' + INVENTORY; }
      else row.note = 'saved but disabled: it reaches no shell';
      out.serviceKeys.push(row);
    }
  } else out.notes.push('service keys not read');
  const rows = out.connectors.concat(out.serviceKeys);
  out.drift = rows.some(r => r.status === 'drift');
  out.unverified = rows.some(r => r.status === 'unverified');
  out.ok = !out.drift && !out.unverified;
  return out;
}
const exitCode = v => (v.drift ? 1 : v.unverified ? 3 : 0);

function print(v) {
  const rows = v.connectors.concat(v.serviceKeys);
  if (!rows.length) console.log('connector-scope: no connectors configured — nothing to check');
  for (const r of rows) {
    const tag = r.status === 'drift' ? 'DRIFT ' : r.status === 'unverified' ? 'UNVERIFIED ' : 'OK    ';
    const what = r.id.startsWith('servicekey:') ? r.id + ' (' + (r.enabled ? 'enabled' : 'disabled') + ')' : r.id + ' (' + r.state + (r.enabled ? '' : ', disabled') + ', ' + r.toolCount + ' tools)';
    console.log(tag + what + (r.note ? ': ' + r.note : ''));
    for (const p of r.problems) console.log('      - ' + p);
    if (r.restore) console.log('      restore: ' + r.restore);
  }
  for (const n of v.notes) console.log('note: ' + n);
}

// the saved policy header value of each policy connector: true / false / null (unknown). Never returns the value.
function savedHeaderValues(file) {
  const out = {};
  let j; try { j = JSON.parse(fs.readFileSync(file || STATE_FILE(), 'utf8')); } catch (_) { return out; }
  if (!j || typeof j !== 'object' || j.format || !Array.isArray(j.configs)) return out;   // encrypted or unknown layout
  for (const [id, p] of Object.entries(POLICY)) {
    const c = j.configs.find(x => x && x.id === id); if (!c) continue;
    const h = c.headers && typeof c.headers === 'object' ? c.headers : {};
    const k = Object.keys(h).find(x => x.toLowerCase() === p.header.toLowerCase());
    out[id] = k ? String(h[k]).trim().toLowerCase() === p.value : false;
  }
  return out;
}

async function collect(opts) {
  opts = opts || {};
  const timeout = opts.timeoutMs || 20000;
  let token;
  try { token = co.stationToken(); } catch (_) { return { error: 'cannot read the station token (secrets/station-token)' }; }
  const get = async p => { const res = await fetch(STATION + p, { headers: { 'x-starnet-token': token }, signal: AbortSignal.timeout(timeout) }); if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); };
  let list;
  try { const body = await get('/api/connectors'); list = Array.isArray(body && body.connectors) ? body.connectors : []; }
  catch (e) { return { error: 'station unreachable or refused /api/connectors (' + String((e && e.message) || e).slice(0, 120) + ')' }; }
  let serviceKeys = null;
  try { const body = await get('/api/servicekeys'); serviceKeys = Array.isArray(body && body.keys) ? body.keys.map(k => ({ id: k.id, name: k.name, envVar: k.envVar, enabled: k.enabled })) : null; } catch (_) {}
  return { list, serviceKeys, headerValue: savedHeaderValues() };
}

function selftest() {
  // the 28 tools GitHub publishes with X-MCP-Readonly: true
  const live28 = ['get_commit', 'get_file_contents', 'get_label', 'get_latest_release', 'get_me', 'get_release_by_tag', 'get_tag', 'get_team_members', 'get_teams', 'issue_read', 'list_branches', 'list_commits', 'list_issue_fields', 'list_issue_types', 'list_issues', 'list_pull_requests', 'list_releases', 'list_repository_collaborators', 'list_tags', 'pull_request_read', 'run_secret_scanning', 'search_code', 'search_commits', 'search_issues', 'search_pull_requests', 'search_repositories', 'search_users', 'ui_get'];
  // the 18 writes GitHub published before the header
  const writes18 = ['merge_pull_request', 'push_files', 'create_or_update_file', 'delete_file', 'create_branch', 'create_repository', 'fork_repository', 'create_pull_request', 'update_pull_request', 'update_pull_request_branch', 'issue_write', 'sub_issue_write', 'add_issue_comment', 'update_issue_comment', 'add_reply_to_pull_request_comment', 'add_comment_to_pending_review', 'pull_request_review_write', 'request_copilot_review'];
  const good = { id: 'github', state: 'up', enabled: true, url: 'https://api.githubcopilot.com/mcp', headers: { 'X-MCP-Readonly': '<set>' }, tools: live28, toolCount: live28.length };
  const T = { headerValue: { github: true }, serviceKeys: [] };
  const down = Object.assign({}, good, { state: 'error', tools: [], toolCount: 0 });
  const st = (list, extra) => { const v = judge(list, extra); return v.drift ? 'drift' : v.unverified ? 'unverified' : 'in scope'; };
  const cases = [
    ['scoped github (live 28 tools) passes', () => st([good], T), 'in scope'],
    ['no connectors passes', () => st([], T), 'in scope'],
    ['header removed', () => st([Object.assign({}, good, { headers: {} })], T), 'drift'],
    ['write tool published', () => st([Object.assign({}, good, { tools: live28.concat(['merge_pull_request']) })], T), 'drift'],
    ['every one of the 18 old writes counts as a write', () => (writes18.every(n => !isRead(POLICY.github, n)) ? 'yes' : 'no'), 'yes'],
    ['mark_all_notifications_read counts as a write', () => st([Object.assign({}, good, { tools: live28.concat(['mark_all_notifications_read']) })], T), 'drift'],
    ['URL moved', () => st([Object.assign({}, good, { url: 'https://example.com/mcp' })], T), 'drift'],
    ['auth "any" accepts the OAuth sign-in', () => st([Object.assign({}, good, { oauth: true })], T), 'in scope'],
    ['auth "token": an OAuth sign-in is drift', () => { const was = POLICY.github.auth; POLICY.github.auth = 'token'; try { return st([Object.assign({}, good, { oauth: true })], T) + '/' + st([Object.assign({}, good, { oauth: false })], T); } finally { POLICY.github.auth = was; } }, 'drift/in scope'],
    ['unknown connector', () => st([good, { id: 'notion', state: 'up', url: 'https://mcp.notion.com/mcp', headers: {}, tools: ['search'] }], T), 'drift'],
    ['saved header value is not "true"', () => st([good], { headerValue: { github: false }, serviceKeys: [] }), 'drift'],
    ['down, header key set, saved value unknown -> UNVERIFIED, not OK', () => st([down], { headerValue: {}, serviceKeys: [] }), 'unverified'],
    ['down, saved value "true" -> in scope (no tools reach agents)', () => st([down], T), 'in scope'],
    ['disabled and saved value unknown -> UNVERIFIED', () => st([Object.assign({}, good, { enabled: false })], { headerValue: {}, serviceKeys: [] }), 'unverified'],
    ['restore for a disabled connector keeps it disabled', () => (judge([Object.assign({}, down, { enabled: false, headers: {} })], T).connectors[0].restore.includes('"enabled":false') ? 'yes' : 'no'), 'yes'],
    ['an enabled GitHub service key is drift', () => st([good], { headerValue: { github: true }, serviceKeys: [{ id: 'github', name: 'GitHub', envVar: 'GITHUB_API_KEY', enabled: true }] }), 'drift'],
    ['a disabled GitHub service key, or another platform, is not', () => st([good], { headerValue: { github: true }, serviceKeys: [{ id: 'github', name: 'GitHub', envVar: 'GITHUB_API_KEY', enabled: false }, { id: 'openweather', name: 'OpenWeather', envVar: 'OPENWEATHER_API_KEY', enabled: true }] }), 'in scope'],
    ['duty: nothing saved, nothing flagged -> not due', () => String(dutyResult({}, {})), 'null'],
    ['duty: a saved header that is not "true" is due, by id only', () => { const r = dutyResult({ github: false }, {}); return r && r.items.map(i => i.id).join(',') + '|' + /never|token/.test(JSON.stringify(r)); }, 'connector:github|false'],
    ['duty: a drift locked-watch flagged is due until it clears', () => { const r = dutyResult({ github: true }, { 'servicekey:github': { flagged: 'abc' }, github: { flagged: 'def' } }); return r && r.items.map(i => i.id).join(','); }, 'connector:github,servicekey:github'],
    ['saved header value is read as a yes/no only', () => { const os = require('os'); const d = require('./lib/temp-life').tmpDir('cscope-'); const f = path.join(d, 'state.json');
      fs.writeFileSync(f, JSON.stringify({ version: 2, configs: [{ id: 'github', headers: { 'x-mcp-readonly': 'TRUE' }, token: 'never-read' }], oauth: { byId: { github: { accessToken: 'never-read' } } } }));
      const a = savedHeaderValues(f); fs.writeFileSync(f, JSON.stringify({ version: 2, configs: [{ id: 'github', headers: { 'X-MCP-Readonly': 'false' } }] })); const b = savedHeaderValues(f);
      fs.writeFileSync(f, JSON.stringify({ format: 'sealed-v1', data: 'x' })); const c = savedHeaderValues(f); fs.rmSync(d, { recursive: true, force: true });
      return JSON.stringify([a, b, c]); }, JSON.stringify([{ github: true }, { github: false }, {}])],
  ];
  let bad = 0;
  for (const [name, fn, want] of cases) {
    let got; try { got = fn(); } catch (e) { got = 'threw ' + e.message; }
    console.log((got === want ? 'ok   ' : 'FAIL ') + name + ' -> ' + got);
    if (got !== want) bad++;
  }
  console.log(bad ? bad + ' case(s) failed' : 'selftest: ' + cases.length + ' cases pass');
  process.exit(bad ? 1 : 0);
}

/* duty (docs/DUTIES.md): what can be known without the network. headerValue = savedHeaderValues(); watched = the
   locked-watch baseline's connectors map ({ id: { flagged: sig } }, drift reported and not cleared). Ids only. */
function dutyResult(headerValue, watched) {
  const items = [];
  for (const [id, v] of Object.entries(headerValue || {})) if (v === false) items.push({ id: 'connector:' + id, why: 'saved ' + POLICY[id].header + ' is not "' + POLICY[id].value + '"' });
  for (const [id, w] of Object.entries(watched || {})) if (w && w.flagged && !items.some(i => i.id === 'connector:' + id && !id.startsWith('servicekey:'))) items.push({ id: id.startsWith('servicekey:') ? id : 'connector:' + id, why: 'drift flagged by locked-watch' });
  if (!items.length) return null;
  const ids = items.map(i => i.id.replace(/[^A-Za-z0-9:._-]/g, '')).sort();
  const key = 'cs-' + require('crypto').createHash('sha256').update(ids.join(',')).digest('hex').slice(0, 10);
  return { due: true, reason: ids.length + ' connector scope finding(s): ' + ids.join(', ') + ' (run connector-scope.js for the details)', key, items: ids.map(id => ({ id })) };
}
function duty() {
  const base = co.readJson(path.join(ROOT, 'company', 'state', 'locked', 'baseline.json'), null) || {};
  const r = dutyResult(savedHeaderValues(), base.connectors || {});
  if (r) console.log(JSON.stringify(r));
  return r ? 1 : 0;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--duty')) process.exit(duty());
  if (args.includes('--selftest')) selftest();
  else collect().then(r => {
    if (r.error) { console.log('connector-scope: ' + r.error); process.exit(2); }
    const v = judge(r.list, r);
    if (args.includes('--json')) console.log(JSON.stringify(v, null, 2)); else print(v);
    process.exit(exitCode(v));
  });
}
module.exports = { judge, collect, savedHeaderValues, exitCode, isRead, POLICY, dutyResult };
