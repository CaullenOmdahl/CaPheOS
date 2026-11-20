/* lib/improve.js — the improvement engine's generators: plain code that turns what the company's own records show into
 * work items for the right seat (docs/IMPROVE.md). No model decides when they run: each one is a read-only duty
 * (docs/DUTIES.md) run by the dispatcher, through a thin tool file (company/tools/improve-<kind>.js).
 *
 *   const I = require('./lib/improve')
 *   I.health({ root, now })        units/loops seen alive, dispatch-log errors, failed runs and tool errors, crash loops,
 *                                  the instance guard, framework files changed in place  -> the platform (tools) seat
 *   I.efficiency({ root, now })    runs over 1M tokens, idle wakes, a seat's tokens today vs its last-week daily mean
 *   I.ownerExperience({ root, now })  jargon in what the owner was sent (outbound, digest), owner asks the crew could
 *                                  decide or that were sent back                  -> the product seat, else the platform
 *   I.frameworkRequests({ root })  every company/work/framework-requests/fr-*.md with no State/Status line -> platform lead
 *   I.research({ root, now })      one market/competition research item a week   -> the research seat
 *   I.retro({ root, now })         one retro item a week (Friday onward)          -> the CEO
 * Each returns null (nothing due) or { due: true, reason, key, route, items: [{ id, route? }] }. Item ids are stable
 * for the same finding, so the dispatcher's dedup (an OPEN handoff or quest already naming the id) keeps one item per
 * finding. Reads are bounded (lib/bounded.js); nothing is written; no socket.
 * Owner: the tools function (the platform department where there is one).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const H = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 6);
const DAY = 86400e3;
const RUNBOOK = 'company/runbooks/improvement.md';

function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } }
function rootOf(o) { return path.resolve((o && o.root) || process.env.CAPHEOS_ROOT || path.join(__dirname, '..', '..', '..')); }
function tz(root) { const c = readJson(path.join(root, 'company', 'company.json'), {}) || {}; return process.env.CAPHEOS_TZ || c.timezone || 'UTC'; }
function local(ms, zone) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' });
  const o = {}; for (const x of f.formatToParts(new Date(ms))) o[x.type] = x.value;
  return { date: o.year + '-' + o.month + '-' + o.day, stamp: o.year + '-' + o.month + '-' + o.day + ' ' + (o.hour === '24' ? '00' : o.hour) + ':' + o.minute, weekday: o.weekday };
}
// ISO week id of a local date, e.g. 2026-W47
function isoWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z'); const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const y = d.getUTCFullYear(); const jan4 = new Date(Date.UTC(y, 0, 4));
  const w = 1 + Math.round(((d - jan4) / DAY - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return y + '-W' + String(w).padStart(2, '0');
}

/* ---- who gets what ---- */
function crew(root) { return (readJson(path.join(root, 'company', 'tools', 'loops.json'), {}) || {}).agents || {}; }
function departments(root) { const d = readJson(path.join(root, 'company', 'departments.json'), null); return (d && Array.isArray(d.departments)) ? d.departments : []; }
function platformDept(root) { return departments(root).find(d => d && d.id === 'platform') || null; }
function byTitle(root, re) { const c = crew(root); return Object.keys(c).find(id => re.test(String(c[id].title || '')) || re.test(id)) || null; }
function routes(root) {
  const c = crew(root); const p = platformDept(root);
  const platform = (p && p.lead && c[p.lead]) ? p.lead : 'tools';
  const research = c.researcher ? 'researcher' : byTitle(root, /research/i);
  const product = byTitle(root, /product/i) || platform;
  return { platform, research, product, ceo: 'ceo', hasPlatform: !!p };
}

/* ---- the records ---- */
function bounded() { return require('./bounded'); }
function runsSince(root, sinceMs, maxBytes) {
  const f = path.join(root, '.starnet-data', 'workspaces', 'runs.jsonl');
  if (!fs.existsSync(f)) return [];
  const tsOf = r => Number(r && (r.endedAt || r.ts || r.startedAt)) || 0;
  const rows = bounded().jsonlWindow(f, { sinceMs, tsOf, maxBytes: maxBytes || (24 << 20), slackMs: 0 }).rows;
  return rows.filter(r => r && r.runId && !r.kind && tsOf(r) >= sinceMs);
}
function jsonlTail(file, n) {
  if (!fs.existsSync(file)) return [];
  return bounded().tailLines(file, n, { maxBytes: 4 << 20 }).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}
function result(items, reasonOf, route, prefix) {
  if (!items.length) return null;
  const ids = items.map(i => i.id).sort();
  return { due: true, reason: reasonOf(items).slice(0, 300), key: prefix + '-' + H(ids.join(',')), route, items: items.slice(0, 50) };
}
const PROVIDER_CODES = new Set(['billing', 'quota_exhausted', 'rate_limit', 'content_policy_blocked']);

/* ---- (a) health ---- */
const LOG_CODES = [
  ['config-error', /CONFIG ERROR/], ['no-loop', /\bNO LOOP\b/], ['stalled', /\bSTALL(?:ED)?\b/], ['job-failed', /JOB FAILED/],
  ['no-model', /NOTHING CAN RUN|NO MODEL HOLD/], ['locked-watch', /LOCKED WATCH: flagged/], ['broken-duty', /duty \S+ is broken|BROKEN/],
];
function health(o) {
  const root = rootOf(o), now = (o && o.now) || Date.now(), zone = tz(root), R = routes(root);
  const items = []; const add = (id, why) => { if (!items.some(i => i.id === id)) items.push({ id, why }); };
  // dispatch log lines from the last 2 hours
  const since = local(now - 2 * 3600e3, zone).stamp;
  const logF = path.join(root, 'company', 'work', 'dispatch-log.md');
  if (fs.existsSync(logF)) {
    const lines = bounded().tailText(logF, 1 << 20).split('\n');
    let restarts = 0; const C = crew(root);
    for (const l of lines) {
      const m = /^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) (.*)$/.exec(l); if (!m || m[1] < since) continue;
      const text = m[2];
      if (/^RUN\b/.test(text) || /duty:/.test(text)) continue;   // a run line quotes its reasons, never a finding
      // a restart is the line restart-station.js writes once it has restarted the station ("Station restarted to ..."); a
      // wait line ("... before restarting the station") or a quoted handoff title is not one
      if (/^Station restarted\b/.test(text)) restarts++;
      for (const [code, re] of LOG_CODES) {
        if (!re.test(text)) continue;
        const seat = Object.keys(C).find(id => new RegExp('(?:^|[\\s(])' + id.replace(/[-]/g, '\\-') + '(?=[\\s):,]|$)').test(text));
        add('health:log:' + code + ':' + (seat || H(text.replace(/\d+/g, '#').slice(0, 120))), code + (seat ? ' (' + seat + ')' : ''));
        break;
      }
    }
    if (restarts >= 3) add('health:crashloop:station', 'station restarted ' + restarts + ' times in 2 h');
  }
  // runs from the last 2 hours: framework failures (provider failures counted apart) and tool errors
  const runs = runsSince(root, now - 2 * 3600e3, 8 << 20);
  const fails = {}, tools = {};
  for (const r of runs) {
    const failed = r.reason && r.reason !== 'done' && r.reason !== 'cancelled' && r.reason !== 'interrupted';
    if (failed) { const code = r.failureCode || r.reason; const k = (PROVIDER_CODES.has(code) ? 'provider-' : '') + code + ':' + r.agentId; fails[k] = (fails[k] || 0) + 1; }
    for (const t of Array.isArray(r.toolTrace) ? r.toolTrace : []) if (t && (t.isError || t.ok === false)) { const k = String(t.name || 'tool') + ':' + r.agentId; tools[k] = (tools[k] || 0) + 1; }
  }
  for (const [k, n] of Object.entries(fails)) if (n >= 2 || !/^provider-/.test(k)) add('health:run:' + k.replace(/[^A-Za-z0-9:_-]/g, ''), n + ' failed run(s) ' + k);
  for (const [k, n] of Object.entries(tools)) if (n >= 3) add('health:tool:' + k.replace(/[^A-Za-z0-9:_-]/g, ''), n + ' tool errors ' + k);
  // no station run at all in 6 hours while the crew has seats: the station or the dispatcher may be down
  if (Object.keys(crew(root)).length && fs.existsSync(path.join(root, '.starnet-data', 'workspaces', 'runs.jsonl')) && !runsSince(root, now - 6 * 3600e3, 4 << 20).length) add('health:no-runs-6h', 'no run in 6 h');
  // the instance guard and framework files edited in place (a founded checkout only)
  if (fs.existsSync(path.join(root, 'company', 'work', '.founded')) && fs.existsSync(path.join(root, '.git'))) {
    const g = path.join(root, 'scripts', 'instance-guard.sh');
    if (fs.existsSync(g)) { try { execFileSync('bash', [g, '--check'], { cwd: root, timeout: 8000, stdio: 'ignore' }); } catch (e) { add('health:instance-guard', 'instance guard check fails'); } }
    try {
      const out = execFileSync('git', ['--no-optional-locks', 'status', '--porcelain', '-uno'], { cwd: root, timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const files = out.split('\n').filter(Boolean).map(l => l.slice(3)).sort();
      if (files.length) add('health:git-dirty:' + H(files.join(',')), files.length + ' framework file(s) changed in place');
    } catch (_) {}
  }
  return result(items.map(i => ({ id: i.id, route: R.platform })), its => 'health: ' + its.length + ' finding(s): ' + items.slice(0, 6).map(i => i.why).join('; ') + '. What to do: ' + RUNBOOK, R.platform, 'health');
}

/* ---- (b) efficiency ---- */
const fresh = r => Math.max(0, (Number(r.tokens) || 0) - (Number(r.cachedTokens) || 0));
const WRITE_TOOLS = /write|edit|patch|apply|create|append|commit|send|post|handoff/i;
function efficiency(o) {
  const root = rootOf(o), now = (o && o.now) || Date.now(), zone = tz(root), R = routes(root);
  const day = local(now, zone).date;
  const runs = runsSince(root, now - 8 * DAY, 24 << 20);
  const items = [];
  const recent = runs.filter(r => (Number(r.endedAt || r.ts) || 0) >= now - DAY);
  const big = {};
  for (const r of recent) if (fresh(r) > 1e6) { const b = big[r.agentId] = big[r.agentId] || { n: 0, max: 0 }; b.n++; b.max = Math.max(b.max, fresh(r)); }
  for (const [seat, b] of Object.entries(big)) items.push({ id: 'eff:big:' + seat + ':' + day, why: seat + ' had ' + b.n + ' run(s) over 1M fresh tokens (largest ' + Math.round(b.max / 1e5) / 10 + 'M)' });
  const per = {};
  for (const r of recent) {
    const s = per[r.agentId] = per[r.agentId] || { runs: 0, idle: 0 };
    s.runs++;
    const trace = Array.isArray(r.toolTrace) ? r.toolTrace : [];
    const wrote = (Array.isArray(r.artifacts) && r.artifacts.length) || trace.some(t => t && WRITE_TOOLS.test(String(t.name || '') + ' ' + String(t.summary || '')));
    if (r.reason === 'done' && !wrote && trace.length <= 3) s.idle++;
  }
  for (const [seat, s] of Object.entries(per)) if (s.idle >= 5 && s.idle / s.runs >= 0.3) items.push({ id: 'eff:idle:' + seat + ':' + day, why: seat + ' had ' + s.idle + ' of ' + s.runs + ' runs that changed nothing' });
  const today = {}, week = {};
  for (const r of runs) { const t = Number(r.endedAt || r.ts) || 0; const tk = Number(r.tokens) || 0; if (t >= now - DAY) today[r.agentId] = (today[r.agentId] || 0) + tk; else week[r.agentId] = (week[r.agentId] || 0) + tk; }
  const first = runs.reduce((m, r) => Math.min(m, Number(r.endedAt || r.ts) || now), now);
  const days = Math.max(1, Math.min(7, (now - DAY - first) / DAY));
  for (const [seat, tk] of Object.entries(today)) { const mean = (week[seat] || 0) / days; if (tk > 5e6 && tk > 3 * mean) items.push({ id: 'eff:spike:' + seat + ':' + day, why: seat + ' used ' + Math.round(tk / 1e5) / 10 + 'M tokens today vs ' + Math.round(mean / 1e5) / 10 + 'M a day last week' }); }
  return result(items.map(i => ({ id: i.id, route: R.platform })), () => 'efficiency: ' + items.length + ' finding(s): ' + items.slice(0, 5).map(i => i.why).join('; ') + '. What to do: ' + RUNBOOK, R.platform, 'eff');
}

/* ---- (c) owner experience ---- */
function ownerExperience(o) {
  const root = rootOf(o), now = (o && o.now) || Date.now(), R = routes(root);
  let words = null; try { words = require('./owner-scope').wordsProblems; } catch (_) {}
  const items = [];
  const since = now - DAY;
  if (words) {
    for (const f of ['outbound.jsonl', 'digest.jsonl']) {
      for (const r of jsonlTail(path.join(root, 'company', 'owner', f), 300)) {
        const t = Date.parse(r.at || ''); if (!(t >= since)) continue;
        const bad = words(r.text || ''); if (!bad.length) continue;
        items.push({ id: 'ux:jargon:' + String(r.id || H(r.text)).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40), why: bad.length + ' hard word(s) in a message from ' + String(r.from || 'the crew').slice(0, 20) });
      }
    }
  }
  // owner cards sent back to the crew (already permitted / not an owner matter): pm-inbox rows marked so
  for (const r of jsonlTail(path.join(root, 'company', 'pm-inbox.jsonl'), 300)) {
    const t = Date.parse(r.at || r.ts || ''); if (!(t >= since)) continue;
    const s = JSON.stringify([r.status, r.state, r.outcome, r.refused, r.bounced, r.sentBack]).toLowerCase();
    if (/refus|bounc|sent.?back|not an owner|already (?:allowed|permitted)|returned/.test(s)) items.push({ id: 'ux:ask:' + String(r.id || r.ref || H(JSON.stringify(r))).replace(/[^A-Za-z0-9_:-]/g, '').slice(0, 40), why: 'an owner ask was sent back' });
  }
  const uniq = items.filter((x, i) => items.findIndex(y => y.id === x.id) === i);
  return result(uniq.map(i => ({ id: i.id, route: R.product })), () => 'owner experience: ' + uniq.length + ' finding(s) in the last day: ' + uniq.slice(0, 4).map(i => i.why).join('; ') + '. Check against docs/USER.md; what to do: ' + RUNBOOK, R.product, 'ux');
}

/* ---- (d) framework requests ---- */
const STATE_RE = /^\s*(?:[-*]\s*)?\**(?:State|Status)\**\s*:/im;
function frameworkRequests(o) {
  const root = rootOf(o), R = routes(root);
  if (!R.hasPlatform) return null;   // only a company with a platform department turns requests into PRs
  const dir = path.join(root, 'company', 'work', 'framework-requests');
  let names = []; try { names = fs.readdirSync(dir).filter(n => /^fr-\d+\.md$/.test(n)).sort(); } catch (_) { return null; }
  const open = names.filter(n => { try { return !STATE_RE.test(fs.readFileSync(path.join(dir, n), 'utf8').slice(0, 8192)); } catch (_) { return false; } });
  const items = open.map(n => ({ id: 'fr:' + n.replace(/\.md$/, ''), route: R.platform }));
  return result(items, its => 'framework requests: ' + its.length + ' with no State line (' + its.slice(0, 8).map(i => i.id).join(', ') + (its.length > 8 ? ', ...' : '') + '). Each ends as a PR or a recorded no: ' + RUNBOOK, R.platform, 'fr');
}

/* ---- (e) weekly research, (f) weekly retro ---- */
function weekly(o, kind) {
  const root = rootOf(o), now = (o && o.now) || Date.now(), zone = tz(root), R = routes(root);
  const L = local(now, zone); const wk = isoWeek(L.date);
  if (kind === 'research') {
    if (!R.research) return null;
    if (fs.existsSync(path.join(root, 'company', 'work', 'research', 'ideas-' + wk + '.md'))) return null;
    return { due: true, route: R.research, key: 'research-' + wk, items: [{ id: 'research:' + wk, route: R.research }],
      reason: 'weekly market and competition research ' + wk + ': forums, launches, GitHub trending, competitors docs, how they explain things to a non-technical owner. Output idea cards in company/work/research/ideas-' + wk + '.md (' + RUNBOOK + ')' };
  }
  if (!['Fri', 'Sat', 'Sun'].includes(L.weekday)) return null;
  if (fs.existsSync(path.join(root, 'company', 'work', 'retro', 'retro-' + wk + '.md'))) return null;
  return { due: true, route: R.ceo, key: 'retro-' + wk, items: [{ id: 'retro:' + wk, route: R.ceo }],
    reason: 'weekly retro ' + wk + ': what went well, what broke, what the improvement items changed; each action with a yes/no check. Write company/work/retro/retro-' + wk + '.md (' + RUNBOOK + ')' };
}
const research = o => weekly(o, 'research');
const retro = o => weekly(o, 'retro');

const GENERATORS = { health, efficiency, owner: ownerExperience, fr: frameworkRequests, research, retro };

/* a tool file's whole main: `--duty` prints the result and exits 1 when due; otherwise a readable report */
function main(kind, argv) {
  const g = GENERATORS[kind];
  let r; try { r = g({}); } catch (e) { console.error(kind + ': ' + (e && e.message)); process.exit(2); }
  if (argv.includes('--duty')) { if (r) console.log(JSON.stringify(r)); process.exit(r ? 1 : 0); }
  if (argv.includes('--json')) console.log(JSON.stringify(r || { due: false }, null, 1));
  else console.log(r ? r.reason + '\n' + r.items.map(i => '  ' + i.id + ' -> ' + (i.route || r.route)).join('\n') : kind + ': nothing due');
  process.exit(0);
}

module.exports = { health, efficiency, ownerExperience, frameworkRequests, research, retro, routes, isoWeek, local, GENERATORS, main, RUNBOOK };
