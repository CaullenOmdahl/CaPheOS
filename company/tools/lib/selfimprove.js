'use strict';
/* selfimprove.js — the shared bits of the self-improvement pipeline (the company improves the framework on its own):
 * company/tools/capheos-merge.js (the merge tool), capheos-main-watch.js (the tripwire on the framework's main) and
 * staged-update.js (the crew's staged framework update with a watchdog and automatic rollback).
 *
 * Settings: company/state/selfimprove.json (absent = defaults, everything off):
 *   { "enabled": false,            the tripwire ticks and the crew may apply framework updates
 *     "requireMergeTool": false,   an agent's `gh pr merge` is refused unless the merge tool runs it (merge-gate.js check-gh)
 *     "repo": "CaullenOmdahl/CaPheOS",
 *     "sandboxRoot": "~/Companies/capheos-sandbox",   the company that takes an update first
 *     "soakMin": 30, "watchMin": 30, "watchEveryMin": 5, "mergeLogs": [] }   extra capheos-merges.jsonl files to trust
 * Merge records: company/state/capheos-merges.jsonl, one row per merge the tool made, plus `baseline` rows (a commit the
 * owner took as known-good). The tripwire and the staged update read the rows of every company under ~/Companies (they
 * all merge into the same repo), plus mergeLogs.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const co = require('./company');

const REAL_GH = '/usr/bin/gh';
const REAL_GIT = '/usr/bin/git';
const DEFAULTS = { enabled: false, requireMergeTool: false, repo: 'CaullenOmdahl/CaPheOS', sandboxRoot: path.join(os.homedir(), 'Companies', 'capheos-sandbox'), soakMin: 30, watchMin: 30, watchEveryMin: 5, mergeLogs: [] };
const TOKEN_ENV = 'CAPHEOS_MERGE_TOOL_TOKEN';

const rootOf = r => path.resolve(r || co.ROOT);
const P = (root, ...a) => path.join(rootOf(root), ...a);
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const readJsonl = f => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); } catch (_) { return []; } };
const appendJsonl = (f, row) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify(row) + '\n'); return row; };
const expand = p => String(p || '').replace(/^~(?=\/|$)/, os.homedir());

function config(root) {
  const c = Object.assign({}, DEFAULTS, readJ(P(root, 'company', 'state', 'selfimprove.json'), {}) || {});
  c.sandboxRoot = path.resolve(expand(c.sandboxRoot));
  return c;
}
const real = p => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };
const isSandbox = root => real(rootOf(root)) === real(config(root).sandboxRoot);

const MERGES_REL = ['company', 'state', 'capheos-merges.jsonl'];
const mergesFile = root => P(root, ...MERGES_REL);
/* every merge-record file we trust: this company's, every company's under ~/Companies, and mergeLogs */
function mergeFiles(root) {
  const out = new Set([mergesFile(root)]);
  const base = process.env.CAPHEOS_COMPANIES_DIR || path.join(os.homedir(), 'Companies');
  try { for (const d of fs.readdirSync(base)) out.add(path.join(base, d, ...MERGES_REL)); } catch (_) {}
  for (const f of config(root).mergeLogs || []) out.add(path.resolve(expand(f)));
  return [...out];
}
function mergeRows(root) { return mergeFiles(root).flatMap(f => readJsonl(f)); }
/* the commits a gated merge (or an owner baseline) put on main: { sha -> row } */
function trustedShas(root) {
  const m = new Map();
  for (const r of mergeRows(root)) for (const s of [r.mergeCommit, r.kind === 'baseline' ? r.sha : null]) if (s && /^[0-9a-f]{40}$/.test(s)) m.set(s, r);
  return m;
}

function gh(args, opts) {
  const r = spawnSync(REAL_GH, args, Object.assign({ encoding: 'utf8', timeout: 60000, maxBuffer: 32 << 20 }, opts || {}));
  return { ok: r.status === 0, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() || (r.error ? r.error.message : '') };
}
function ghJson(args) { const r = gh(args); if (!r.ok) throw new Error('gh ' + args.slice(0, 3).join(' ') + ': ' + r.err.split('\n')[0]); return JSON.parse(r.out || 'null'); }

/* CI on a commit: { green, pending, failed: [names], runs } from GitHub's check runs (+ legacy statuses) */
const OK_CONCL = new Set(['success', 'skipped', 'neutral']);
function ciOf(repo, sha) {
  const cr = ghJson(['api', 'repos/' + repo + '/commits/' + sha + '/check-runs?per_page=100', '--jq', '[.check_runs[] | {name, status, conclusion}]']) || [];
  let st = []; try { st = ghJson(['api', 'repos/' + repo + '/commits/' + sha + '/status', '--jq', '[.statuses[] | {name: .context, status: "completed", conclusion: .state}]']) || []; } catch (_) {}
  const runs = cr.concat(st.map(s => Object.assign(s, { conclusion: s.conclusion === 'pending' ? null : s.conclusion, status: s.conclusion === 'pending' ? 'in_progress' : 'completed' })));
  const pending = runs.filter(r => r.status !== 'completed').map(r => r.name);
  const failed = runs.filter(r => r.status === 'completed' && !OK_CONCL.has(String(r.conclusion))).map(r => r.name + ':' + r.conclusion);
  return { green: runs.length > 0 && !pending.length && !failed.length, pending, failed, runs: runs.length };
}

/* who to tell: a P0/OPEN handoff to a seat by function, and a plain owner line. Never throws. */
function tell(root, { seatFn, heading, fields, from, owner, ownerKind }) {
  const out = {};
  try {
    const kit = require('./modkit');
    const id = co.seatFor(seatFn || 'risk');
    out.handoff = id ? kit.appendHandoff(id, heading, fields || {}, from || 'Self-improvement') : null;
  } catch (e) { out.handoffError = e.message; }
  if (owner) {
    try { out.owner = require('./owner-notice').send({ kind: ownerKind || 'fyi', from: from || 'The crew', text: owner, key: 'selfimprove:' + heading.slice(0, 80) }, { root: rootOf(root) }); }
    catch (e) { out.ownerError = e.message; }
  }
  return out;
}

/* the merge tool's token: written by capheos-merge.js for one merge, checked by merge-gate.js check-gh */
const tokenFile = root => P(root, 'company', 'state', '.merge-tool-token.json');
function issueToken(root, ttlMs) {
  const t = require('crypto').randomBytes(16).toString('hex');
  const f = tokenFile(root); fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ token: t, until: Date.now() + (ttlMs || 120000) }), { mode: 0o600 });
  return t;
}
function tokenValid(root, t) {
  if (!t) return false;
  const d = readJ(tokenFile(root), null);
  return !!(d && d.token === t && d.until > Date.now());
}
function dropToken(root) { try { fs.unlinkSync(tokenFile(root)); } catch (_) {} }

module.exports = { REAL_GH, REAL_GIT, DEFAULTS, TOKEN_ENV, config, isSandbox, mergesFile, mergeFiles, mergeRows, trustedShas, readJ, readJsonl, appendJsonl, gh, ghJson, ciOf, tell, issueToken, tokenValid, dropToken, real };
