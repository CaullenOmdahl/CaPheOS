#!/usr/bin/env node
/* harness-change.js — propose, review, apply and (if results get worse) revert a change to something the crew shares.
 *
 * Three-tier latitude, tier 2 "propose, review, apply": a person may change shared things — a routine's schedule, a
 * shared tool, a house rule, the model a routine runs on, a policy number — but only through a written proposal that
 * says who, what and why, reviewed by the area's function holder (never by the proposer), applied with a backup, and
 * checked three days later against the runs before it. Plain-words guide: company/work/people/LATITUDE.md.
 *
 *   propose --kind schedule|tool|house-rule|model|policy --target <…> --why "…" --change <file or JSON> --by <Name> [--expect "…"]
 *           [--replaces hc-NNNN] [--plain "one plain sentence for the owner, if they are asked"]
 *       schedule    target = routine name or id;  change = "0 9 * * *" or {"expr":"…","tz":"<IANA zone>"} (default: the company timezone)
 *                   target = cadence.json (the company tempo, docs/TEMPO.md);  change = {"/bounds/tickMin":[3,30], "/dispatcherTickMin":4, …}
 *       tool        target = a shared file (company/tools, company/skills, company/runbooks, company/standards);
 *                   change = a unified diff (diff -u / git diff) or the whole new file
 *       house-rule  target = (none);  change = {"add":"…"} | {"remove":"…"} | {"replace":{"from":"…","to":"…"}} (a rule line)
 *       model       target = a routine row of the routing table (company/model-policy.json);  change = the new row, e.g. {"claude":"haiku","minimax":true}
 *       policy      target = pacing-policy.json | dispatch-budget.json | corrections-policy.json | competence-policy.json | model-policy.json (performance);
 *                   change = {"/json/pointer": value, …}
 *   approve <id> --by <reviewer> [--note "…"]      reject <id> --by <reviewer> --note "…"      withdraw <id> --by <proposer>
 *   apply <id> --by <Name>     schedule: POST /api/cron/update; tool and house-rule: syntax check + the tool's selftest, backup,
 *                              atomic rename; model and policy: the file's owner applies — the owner's own edit is recorded,
 *                              or the tool makes exactly the approved edit on the owner's behalf
 *   revert <id> --by <Name> [--why "…"]    puts the old value back, only if the target still has the applied value
 *   keep <id> --by <Name> [--note "…"]     closes the 3-day results check: the change stays
 *   review-due                 applied changes whose 3-day results check is due, with before/after numbers from the run records
 *   list [--all] | show <id> | tick [--dry-run] (the dispatcher: opens the results-check handoffs) | selftest
 *
 * Reviewers are found by function in company/tools/loops.json (seat.functions; lib/company.js). Nobody reviews their own
 * proposal; when every eligible seat is the proposer (a one-seat company), the owner reviews — on Today, never by a command.
 * THE OWNER is asked only through lib/owner-card.js (one card per change, ref harness-review:<id>, plain words up front,
 * the diff only under "Technical details (for the crew)", effect {harnessApply:{id}}), and only when (a) the self-governance
 * level of the change's category is approve, (b) fewer than two crew seats could review a locked tool, or (c) the change
 * would edit, in this company, the code that keeps the fixed owner gates (OWNER_GATE_TOOLS). The card is filed once the
 * crew's reviews are in; owner-card itself sends it back to the crew when governance or a standing owner ruling already
 * covers it. The dispatcher's tick (or the console applying the card's effect, ownerApply) reads the answer: yes records
 * the owner's review and applies the change at once (a framework file in a company checkout becomes a framework request
 * carrying the diff), no rejects it. withdraw also withdraws the card; propose --replaces <id> (or a "Replaces hc-NNNN"
 * line in --why) withdraws the old change first; the same change proposed again by the same person updates the open record.
 *   schedule   the routine owner's manager; the people holder when that manager is the CEO; the CEO for the people
 *              holder's own; the people holder for the CEO's own. cadence.json: the finance, risk AND people holders (the
 *              CEO in for whichever of them proposes), applied by any of them
 *   tool       the tools holder; the risk holder when the tools holder proposes. Tools that measure, limit or protect are locked:
 *              the risk AND tools holders review them (the CEO in for whichever of them proposes), any of them applies
 *   house-rule the tools holder AND the CEO (the risk holder in for whichever of them proposes)
 *   model      the people holder AND the CEO (the routing table is the people holder's); applied by the people holder
 *   policy     pacing/budget: the finance holder (the CEO when they propose), applied by them; corrections, model performance:
 *              the people holder (the CEO when they propose), applied by them; competence: the people AND finance holders
 *              (the CEO in for people, the risk holder for finance)
 * Self-governance at apply time (company/state/governance.json, lib/governance.js): schedule = schedules, model = models,
 *   policy on pacing-policy.json or dispatch-budget.json = budget, every other kind = tools. At auto it applies after the
 *   crew's review; at notify it applies and the owner gets one line in the daily digest (lib/owner-notice.js); at approve
 *   one owner card waits for a yes; triage asks the decision model (lib/governance.js decide).
 * Files: company/work/changes/<id>.json (the record), company/work/changes/<id>/ (the change, the backup), CHANGES.md (summary),
 *        company/work/people/harness-log.jsonl (every event). --by is a claim, recorded as unverified; locked-watch.js checks
 *        agent runs' transcripts for the matching command. Owned by the tools function.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const co = require('./lib/company');
const gov = require('./lib/governance');
const LIVE_ROOT = co.ROOT;
const KINDS = ['schedule', 'tool', 'house-rule', 'model', 'policy'];
const TOOL_NAME = 'Harness changes';
const RESULTS_AFTER_DAYS = 3;
const SHARED_AREAS = ['company/tools/', 'company/skills/', 'company/runbooks/', 'company/standards/'];

/* ---------------- context ---------------- */
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const sha = data => 'sha256:' + crypto.createHash('sha256').update(Buffer.isBuffer(data) ? data : Buffer.from(String(data))).digest('hex');
const fileSha = f => { try { return sha(fs.readFileSync(f)); } catch (_) { return null; } };
// ISO time with the company timezone's offset (co.TZ), e.g. 2026-01-02T09:30:00+01:00
function local(ms) {
  const d = new Date(Math.floor(ms / 1000) * 1000);
  const o = {}; for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: co.TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d)) o[x.type] = x.value;
  const wall = Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour % 24, +o.minute, +o.second);
  const off = Math.round((wall - d.getTime()) / 60000), a = Math.abs(off);
  return new Date(wall).toISOString().slice(0, 19) + (off < 0 ? '-' : '+') + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0');
}
const stamp = ms => local(ms).slice(0, 16).replace('T', ' ');
function context(opts) {
  opts = opts || {};
  const root = path.resolve(opts.root || process.env.HARNESS_ROOT || LIVE_ROOT);
  const P = rel => path.join(root, rel);
  const agents = (readJson(P('company/tools/loops.json'), {}) || {}).agents || {};
  // seats by function (seat.functions, legacy hr/toolsOwner read by co.holds); a function nobody holds falls to the CEO
  const row = id => (id && agents[id] ? Object.assign({ id }, agents[id]) : null);
  const ceoId = Object.keys(agents).find(id => co.holds(agents[id], 'ceo')) || Object.keys(agents).find(id => agents[id] && agents[id].manager == null) || null;
  const holder = fn => row(Object.keys(agents).find(id => co.holds(agents[id], fn))) || row(ceoId);
  const crew = { agents, ceo: row(ceoId), people: holder('people'), tools: holder('tools'), risk: holder('risk'), finance: holder('finance') };
  return { root, P, now: Number.isFinite(opts.now) ? opts.now : Date.now(), crew,
    paths: { dir: P('company/work/changes'), log: P('company/work/people/harness-log.jsonl'), lock: P('company/state/harness-change.lock'), handoffs: P('company/work/handoffs'),
      summary: P('company/work/changes/CHANGES.md'), runs: P('.starnet-data/workspaces/runs.jsonl'), modelPolicy: P('company/model-policy.json'), rules: P('company/tools/routine-rules.js') },
    call: opts.call || ((...a) => require('./station-crew.js').call(...a)),
    underStation: typeof opts.underStation === 'boolean' ? opts.underStation : (() => { try { return require('./provenance.js').underStation(); } catch (_) { return false; } })(),
    ownerShell: typeof opts.ownerShell === 'boolean' ? opts.ownerShell : require('./lib/owner').shell(),   // the one owner rule (lib/owner.js)
    skipSelftest: !!opts.skipSelftest,
    // the owner's two doors (lib/owner-card.js, lib/owner-notice.js); a selftest hands in stand-ins with the same contract
    cards: () => opts.ownerCard || optional('./lib/owner-card'), notices: () => opts.ownerNotice || optional('./lib/owner-notice') };
}
// a module that may not be installed yet: null when it is missing, every other load error is real
function optional(name) {
  try { return require(name); } catch (e) { if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(path.basename(name))) return null; throw e; }
}
const prov = () => { try { return require('./provenance.js'); } catch (_) { return null; } };
const E = (msg, code) => Object.assign(new Error(msg), { code: code || 'refused' });
const relOf = (ctx, f) => path.relative(ctx.root, f).split(path.sep).join('/');
function person(ctx, name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  if (n === 'owner' && !ctx.underStation && ctx.ownerShell) return { id: 'owner', name: 'owner' };
  const e = Object.entries(ctx.crew.agents).find(([, c]) => String((c && c.name) || '').toLowerCase() === n);
  return e ? Object.assign({ id: e[0] }, e[1]) : null;
}
function needBy(ctx, by) {
  const p = person(ctx, by);
  if (!p) throw E('--by <Name> must be someone on the crew (company/tools/loops.json)' + (String(by || '').toLowerCase() === 'owner' ? '; "owner" only from the owner\'s own shell' : ''), 'who');
  return p;
}
// who stands in for a person's manager on people-side approvals: their manager; the people holder when that is the CEO;
// the CEO for the people holder's own; the people holder for the CEO's own
function managerOf(ctx, id) {
  const row = ctx.crew.agents[id] || {}, hr = ctx.crew.people, ceo = ctx.crew.ceo;
  if (ceo && id === ceo.id) return hr;
  if (hr && id === hr.id) return ceo;
  if (row.manager && ceo && row.manager === ceo.id) return hr || ceo;
  if (row.manager && ctx.crew.agents[row.manager]) return Object.assign({ id: row.manager }, ctx.crew.agents[row.manager]);
  return hr || ceo;
}
const pickName = p => p && { id: p.id, name: p.name };
const OWNER = { id: 'owner', name: 'owner' };
// fill `want` (people) minus the proposer; replace each proposer-held seat with the stand-in
function seats(ctx, want, proposer, standIns) {
  const out = [];
  want.forEach((p, i) => {
    let s = p;
    if (!s) return;
    if (s.id === proposer.id) s = standIns[i] || null;
    if (s && s.id !== proposer.id && !out.some(x => x.id === s.id)) out.push(pickName(s));
  });
  // every eligible seat is the proposer (a one-seat company, or one seat holding every function): the owner reviews
  if (!out.length) out.push(OWNER);
  return out;
}

/* ---------------- locked targets (from locked-watch.js) ---------------- */
function classify(ctx, rel) { try { return require('./locked-watch.js').classify(rel, { root: ctx.root }); } catch (_) { return null; } }
// The code that keeps the four fixed owner gates and the owner's own identity (who may answer as the owner, what counts as
// an owner answer, the external gate, the spending cap, the default-branch rule). A change that would edit one of these
// in THIS company always reaches the owner, whatever the governance level, because the crew cannot vouch for the rule
// that limits the crew. A change that becomes a framework request (a framework file in a company checkout) is reviewed by
// the crew only: nothing changes here, and the framework reviews it before any company gets it.
const OWNER_GATE_TOOLS = Object.assign(
  Object.fromEntries(['harness-change.js', 'locked-watch.js', 'provenance.js', 'lib/pm-inbox-guard.js', 'lib/owner-channel.js', 'lib/owner.js', 'lib/owner-card.js',
    'lib/governance.js', 'governance.js', 'guardrails.js', 'lib/guardrails.js', 'delegation.js', 'merge-gate.js', 'default-branch-watch.js'].map(f => ['company/tools/' + f, 'access'])),
  { 'company/tools/external-gate.js': 'commitments' },
  Object.fromEntries(['budget.js', 'money-hold.js', 'lib/money-hold.js'].map(f => ['company/tools/' + f, 'spendBeyondCap'])));
// what a change is about, in words the owner knows (the card's lead and the digest line; never a file name)
const PLAIN_AREAS = [
  [/(^|\/)(pacer|cap-numerator|budget|budget-migrate|money-hold|models-money)\.js$/, 'how the crew\'s spending is paced and capped'],
  [/(^|\/)(competence|performance|model-stats|corrections|my-section|completions)\.js$/, 'how the crew\'s work is measured'],
  [/(^|\/)(dispatch|dispatcher-loop|lanes|admit|scheduler|cadence|duties|duty-status|duty-runner|duty-env|notify-when|seat-status|handoff-archive|retention|watchdog|restart-station|station-crew)\.js$/, 'how work is handed out and kept running'],
  [/(^|\/)(hire|departments)\.js$/, 'how the crew is organised'],
  [/(^|\/)(routing|override-allow|models|providers)\.js$/, 'which AI models do which work'],
  [/(^|\/)routine-rules\.js$/, 'the crew\'s house rules'],
  [/(^|\/)(harness-change|locked-watch|provenance|decision|pm-inbox-guard|owner-channel|owner|owner-card|governance|guardrails|delegation|external-gate|merge-gate|premerge-check|connector-scope|default-branch-watch|deps|gates)\.js$/, 'one of the safeguards that keep the crew inside its limits'],
];
function plainArea(rec) {
  if (rec.kind === 'schedule') return rec.target && rec.target.type === 'json' ? 'how often the crew works' : 'when one of the crew\'s routines runs';
  if (rec.kind === 'model') return 'which AI model one of the crew\'s routines uses';
  if (rec.kind === 'house-rule') return 'the crew\'s house rules';
  if (rec.kind === 'policy') return rec.target && BUDGET_FILES.includes(rec.target.file) ? 'a spending or pacing limit' : 'one of the crew\'s working rules';
  const f = String((rec.target && rec.target.file) || '');
  const hit = PLAIN_AREAS.find(([re]) => re.test(f));
  return hit ? hit[1] : 'one of the crew\'s shared tools';
}
const POLICY_FILES = {
  'company/work/finance/pacing-policy.json': { owner: 'finance', reviewers: ['finance'] },
  'company/work/finance/dispatch-budget.json': { owner: 'finance', reviewers: ['finance'] },
  'company/work/people/corrections-policy.json': { owner: 'people', reviewers: ['people'] },
  'company/model-policy.json': { owner: 'people', reviewers: ['people'], only: '/performance' },
  'company/competence-policy.json': { owner: 'people', reviewers: ['people', 'finance'] },
};
function policyFile(target) {
  const t = String(target || '').replace(/^\.\//, '');
  if (POLICY_FILES[t]) return t;
  const hit = Object.keys(POLICY_FILES).filter(k => k.endsWith('/' + t) || path.basename(k) === t);
  return hit.length === 1 ? hit[0] : null;
}

/* ---------------- JSON pointers ---------------- */
const ptrParts = p => { const s = String(p); return s.startsWith('/') ? s.slice(1).split('/').map(x => x.replace(/~1/g, '/').replace(/~0/g, '~')) : s.split('.'); };
const ptrStr = parts => '/' + parts.map(x => String(x).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
function getPtr(obj, parts) { let o = obj; for (let i = 0; i < parts.length; i++) { if (o == null || typeof o !== 'object' || !Object.prototype.hasOwnProperty.call(o, parts[i])) return { exists: false, parentExists: i === parts.length - 1 && o != null && typeof o === 'object' }; o = o[parts[i]]; } return { exists: true, value: o, parentExists: true }; }
function setPtr(obj, parts, value) { let o = obj; for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]]; if (value === undefined) delete o[parts[parts.length - 1]]; else o[parts[parts.length - 1]] = value; }
const indentOf = txt => { const m = /\n([ \t]+)"/.exec(txt); return m ? m[1] : ' '; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------------- store ---------------- */
const recFile = (ctx, id) => { if (!/^hc-\d{4,6}$/.test(String(id || ''))) throw E('no such change: ' + id, 'input'); return path.join(ctx.paths.dir, id + '.json'); };
function writeAtomic(file, data, writer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, data); fs.renameSync(tmp, file);
  const p = prov(); if (p) p.wrote(file, data, writer || 'harness-change.js');
}
function appendLog(ctx, ev) {
  const line = JSON.stringify(Object.assign({ at: local(ctx.now), tool: 'harness-change' }, ev)) + '\n';
  fs.mkdirSync(path.dirname(ctx.paths.log), { recursive: true });
  fs.appendFileSync(ctx.paths.log, line);
  const p = prov(); if (p) p.appended(ctx.paths.log, line, 'harness-change.js');
}
function loadRec(ctx, id) { const r = readJson(recFile(ctx, id), null); if (!r) throw E('no such change: ' + id, 'input'); return r; }
function saveRec(ctx, rec) { writeAtomic(recFile(ctx, rec.id), JSON.stringify(rec, null, 1) + '\n'); }
function allRecs(ctx) { let f = []; try { f = fs.readdirSync(ctx.paths.dir).filter(x => /^hc-\d{4,6}\.json$/.test(x)).sort(); } catch (_) {} return f.map(x => readJson(path.join(ctx.paths.dir, x), null)).filter(Boolean); }
function nextId(ctx) { let n = 0; for (const r of allRecs(ctx)) { const m = /^hc-(\d+)$/.exec(r.id); if (m) n = Math.max(n, Number(m[1])); } return 'hc-' + String(n + 1).padStart(4, '0'); }
function withLock(ctx, fn) {
  fs.mkdirSync(path.dirname(ctx.paths.lock), { recursive: true });
  const until = Date.now() + 15000;
  for (;;) {
    try { const fd = fs.openSync(ctx.paths.lock, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(ctx.paths.lock).mtimeMs > 300000) { fs.unlinkSync(ctx.paths.lock); continue; } } catch (_) { continue; }
      if (Date.now() >= until) throw E('the change log is busy (company/state/harness-change.lock); try again in a minute', 'busy');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(ctx.paths.lock); } catch (_) {} }
}
const hist = (ctx, rec, event, by, note) => { rec.history = (rec.history || []).concat([{ at: local(ctx.now), event, by: by || null, note: note || undefined }]); };

/* ---------------- handoffs ---------------- */
const flat = v => String(v == null ? '' : v).replace(/[\r\n\u2028\u2029\u0085]+/g, ' ');
function inboxOf(ctx, p) { const row = p && ctx.crew.agents[p.id]; return row && /^[A-Za-z0-9_.-]+\.md$/.test(String(row.inbox || '')) ? row.inbox : null; }
function handoff(ctx, p, heading, fields, dry) {
  if (p && p.id === 'owner') return toOwner(ctx, heading, fields, dry);
  const inbox = inboxOf(ctx, p); if (!inbox) return null;
  const block = '\n## ' + stamp(ctx.now) + ' from ' + TOOL_NAME + ' (company/tools/harness-change.js) — ' + flat(heading) + '\n' +
    Object.entries(fields).map(([k, v]) => '**' + k + ':** ' + flat(v)).join('\n') + '\n';
  if (!dry) { const f = path.join(ctx.paths.handoffs, inbox); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, block); }
  return inbox;
}
// the owner has no handoff file: a crew handoff meant for them (a change they proposed was applied, rejected or is due a
// results check) becomes one plain line in their daily digest, the crew's wording under technical
function toOwner(ctx, heading, fields, dry) {
  const technical = flat(heading) + ' — ' + Object.entries(fields).filter(([k]) => k !== 'Status').map(([k, v]) => k + ': ' + flat(v)).join(' | ');
  if (!dry) tellOwner(ctx, { from: TOOL_NAME, text: 'There is news on a change you asked the crew to make.', technical, key: 'harness-owner:' + sha(technical).slice(7, 23) });
  return 'owner:digest';
}
// flip OPEN -> DONE on this tool's own handoffs whose heading names `needle` (never anyone else's block); onlyFor = one person's inbox
function closeHandoffs(ctx, needle, note, onlyFor) {
  let files = []; try { files = fs.readdirSync(ctx.paths.handoffs).filter(f => /^to-.*\.md$/.test(f)); } catch (_) { return 0; }
  if (onlyFor) { const mine = inboxOf(ctx, onlyFor); files = files.filter(f => f === mine); }
  let n = 0;
  for (const f of files) {
    const file = path.join(ctx.paths.handoffs, f); let txt; try { txt = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    if (!txt.includes(needle)) continue;
    const parts = txt.split(/^(?=## )/m); let changed = false;
    for (let i = 0; i < parts.length; i++) {
      const head = parts[i].split('\n')[0];
      if (head.startsWith('## ') && head.includes('from ' + TOOL_NAME) && head.includes(needle) && /^\*\*Status:\*\*\s*OPEN\b/m.test(parts[i])) { parts[i] = parts[i].replace(/^\*\*Status:\*\*\s*OPEN\b.*$/m, '**Status:** DONE — ' + flat(note)); changed = true; n++; }
    }
    if (changed) fs.writeFileSync(file, parts.join(''));
  }
  return n;
}
const cmdFor = (verb, rec, p, extra) => '`node company/tools/harness-change.js ' + verb + ' ' + rec.id + ' --by ' + (p ? p.name : '<Name>') + (extra || '') + '`';

/* ---------------- kinds: describe, validate, apply, revert ---------------- */
function parseChangeArg(ctx, change) {
  if (change == null || change === true) throw E('--change is required (a file or JSON)', 'input');
  const s = String(change);
  const f = path.resolve(ctx.root, s);
  if (f.startsWith(ctx.root + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile()) {
    if (/(^|\/)\.?secrets(\/|$)|token$|-key$|provider-keys\.json$/.test(f)) throw E('--change names a secret file', 'input');
    if (fs.statSync(f).size > 512 * 1024) throw E('--change file is over 512 KB', 'input');
    return { text: fs.readFileSync(f, 'utf8'), from: relOf(ctx, f) };
  }
  return { text: s, from: 'inline' };
}
const asJson = (t, what) => { try { return JSON.parse(t); } catch (e) { throw E(what + ' must be JSON: ' + e.message, 'input'); } };
const isDiff = t => /^@@ /m.test(t) && /^(---|\+\+\+) /m.test(t);
function routineByTarget(jobs, target) {
  const t = String(target || '').trim();
  const exact = jobs.filter(j => j.id === t || j.name === t);
  if (exact.length === 1) return exact[0];
  const pre = jobs.filter(j => j.name.startsWith(t));
  if (pre.length === 1) return pre[0];
  throw E(pre.length > 1 ? 'target "' + t + '" matches several routines: ' + pre.map(j => j.name).join(', ') : 'no routine "' + t + '"', 'input');
}
async function jobsNow(ctx) { const r = await ctx.call('GET', '/api/cron'); if (!r || r.status !== 200) throw E('the station did not answer GET /api/cron (' + (r && r.status) + ')', 'station'); return JSON.parse(r.body).jobs || []; }
function cronLib(ctx) { for (const f of [path.join(ctx.root, 'starnet/sidecar/cron.js'), path.join(LIVE_ROOT, 'starnet/sidecar/cron.js')]) { try { return require(f); } catch (_) {} } return null; }
function firesPerDay(ctx, expr, tz) {
  const c = cronLib(ctx); if (!c) return null;
  const s = c.parseSchedule(String(expr), ctx.now, { tz: tz || undefined, defaultTz: tz || co.TZ }); if (!s) return null;
  let t = ctx.now, n = 0; const end = ctx.now + 7 * 86400e3;
  for (let i = 0; i < 2000; i++) { const nx = c.nextFireAt(s, new Date(t).toISOString(), t, { defaultTz: tz || co.TZ }); if (!nx || nx > end) break; t = nx; n++; }
  return Math.round(n / 7 * 10) / 10;
}
function syntaxCheck(file, text) {
  const ext = path.extname(file);
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hc-syntax-'));
  const tmp = path.join(dir, 'check' + ext);
  try {
    fs.writeFileSync(tmp, text);
    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') execFileSync('node', ['--check', tmp], { stdio: 'pipe' });
    else if (ext === '.sh') execFileSync('bash', ['-n', tmp], { stdio: 'pipe' });
    else if (ext === '.py') execFileSync('python3', ['-m', 'py_compile', tmp], { stdio: 'pipe' });
    else if (ext === '.json') JSON.parse(text);
    return null;
  } catch (e) { return String((e.stderr && e.stderr.toString()) || e.message).split('\n').slice(0, 4).join(' ').slice(0, 300); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function patchText(original, diff) {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hc-patch-'));
  try {
    const a = path.join(dir, 'target'), d = path.join(dir, 'change.diff'), o = path.join(dir, 'out');
    fs.writeFileSync(a, original); fs.writeFileSync(d, diff);
    execFileSync('patch', ['--batch', '--forward', '--silent', '-o', o, a, d], { stdio: 'pipe', cwd: dir });
    return fs.readFileSync(o, 'utf8');
  } catch (e) { throw E('the diff does not apply to the current file: ' + String((e.stdout && e.stdout.toString()) || e.message).split('\n').slice(0, 3).join(' ').slice(0, 240), 'input'); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
// house rules live in the BLOCK array of company/tools/routine-rules.js; edit one line and bump VERSION
function editRules(src, op) {
  const head = src.indexOf("const BLOCK = START + VERSION + ']\\n' + [");
  const tail = src.indexOf("].join('\\n') + '\\n' + END;", head);
  if (head < 0 || tail < 0) throw E('could not find the house-rules block in routine-rules.js', 'tool');
  const startBody = src.indexOf('\n', head) + 1;
  const lines = src.slice(startBody, tail).split('\n');
  const vm = require('vm');
  const val = l => { const t = l.trim().replace(/,$/, ''); if (!t) return null; try { return vm.runInNewContext('(' + t + ')', {}, { timeout: 100 }); } catch (_) { return null; } };
  const vals = lines.map(val);
  const find = text => { const want = '- ' + String(text).replace(/^-\s*/, '').trim(); const i = vals.findIndex(v => v === want); if (i < 0) throw E('no house rule reads exactly: ' + want.slice(0, 120), 'input'); return i; };
  const lit = text => '  ' + JSON.stringify('- ' + String(text).replace(/^-\s*/, '').trim()) + ',';
  if (op.add) { const last = vals.map((v, i) => (v ? i : -1)).filter(i => i >= 0).pop(); lines.splice(last + 1, 0, lit(op.add)); }
  else if (op.remove) lines.splice(find(op.remove), 1);
  else if (op.replace) lines[find(op.replace.from)] = lit(op.replace.to);
  else throw E('house-rule change must be {"add":…}, {"remove":…} or {"replace":{"from":…,"to":…}}', 'input');
  let out = src.slice(0, startBody) + lines.join('\n') + src.slice(tail);
  const m = /const VERSION = 'v(\d+)';/.exec(out); if (!m) throw E('could not find VERSION in routine-rules.js', 'tool');
  out = out.replace(m[0], "const VERSION = 'v" + (Number(m[1]) + 1) + "';");
  return { src: out, version: 'v' + (Number(m[1]) + 1) };
}
function ruleText(ctx, t) {
  const s = String(t || '').replace(/^-\s*/, '').trim();
  if (s.length < 20 || s.length > 450 || /[\r\n]/.test(s)) throw E('a house rule is one line of 20 to 450 characters', 'input');
  if (/\[(\s*end\s+)?(house rules|your standing corrections|standing corrections|my own section)/i.test(s)) throw E('a house rule cannot contain a managed-block marker', 'input');
  const G = (() => { for (const f of [path.join(ctx.root, 'starnet/sidecar/cron-guard.js'), path.join(LIVE_ROOT, 'starnet/sidecar/cron-guard.js')]) { try { return require(f); } catch (_) {} } return null; })();
  if (!G) throw E('the station\'s prompt check could not be loaded', 'tool');
  const r = G.scanRoutinePrompt(s); if (!r.ok) throw E('the station would refuse this rule in a routine prompt (' + r.patternId + ')', 'input');
  return s;
}
function runSelftest(ctx, target, text) {
  if (ctx.skipSelftest || path.extname(target) !== '.js' || !/['"]selftest['"]/.test(text)) return null;
  const tmp = path.join(path.dirname(target), '.' + path.basename(target, '.js') + '.hc-check-' + process.pid + '.js');
  try {
    fs.writeFileSync(tmp, text);
    execFileSync('node', [tmp, 'selftest'], { cwd: ctx.root, stdio: 'pipe', timeout: 180000 });
    return null;
  } catch (e) { return 'its selftest failed: ' + String((e.stdout && e.stdout.toString()) || e.message).split('\n').filter(l => /FAIL|Error|error/.test(l)).slice(0, 3).join(' | ').slice(0, 300); }
  finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

// The company tempo (company/work/ops/cadence.json: base values outside the crew's bounds, the bounds and tempo blocks,
// seat loop clocks and cooldowns): reviewed by finance (spend rate), risk (liveness, SLA) and people (workload), never the
// proposer; applied by any reviewer. cadence.js proposal() checks the pointers and turns them into whole-section sets.
const CADENCE_TARGET = /^(company\/work\/ops\/)?cadence(\.json)?$/;
const CADENCE_REL = 'company/work/ops/cadence.json';
function describeCadence(ctx, c, proposer) {
  const file = ctx.P(CADENCE_REL);
  const doc = readJson(file, null); if (!doc) throw E(CADENCE_REL + ' cannot be read (it is created at founding from company/defaults/work/ops/cadence.json)', 'tool');
  const set = asJson(c.text.trim(), '--change');
  let norm; try { norm = require('./cadence.js').proposal(doc, set, { agents: ctx.crew.agents, now: ctx.now }); } catch (e) { throw E(e.message, 'input'); }
  const before = {}, absent = [];
  for (const k of Object.keys(norm)) { const g = getPtr(doc, ptrParts(k)); if (g.exists) before[k] = g.value; else absent.push(k); }
  if (Object.keys(norm).every(k => !absent.includes(k) && same(before[k], norm[k]))) throw E('those are already the values', 'input');
  const C = ctx.crew;
  const reviewers = seats(ctx, [C.finance, C.risk, C.people], proposer, [C.ceo, C.ceo, C.ceo]);
  return { target: { type: 'json', file: CADENCE_REL }, change: { set: norm, asked: set }, before: { values: before, absent, sha256: fileSha(file) }, after: {}, reviewers, applier: null, payload: null };
}

async function describe(ctx, kind, target, changeArg, proposer) {
  const c = parseChangeArg(ctx, changeArg);
  if (kind === 'schedule' && CADENCE_TARGET.test(String(target || '').trim())) return describeCadence(ctx, c, proposer);
  if (kind === 'schedule') {
    const jobs = await jobsNow(ctx); const job = routineByTarget(jobs, target);
    const owner = job.agentId && ctx.crew.agents[job.agentId] ? Object.assign({ id: job.agentId }, ctx.crew.agents[job.agentId]) : null;
    if (!owner) throw E('routine "' + job.name + '" has no crew owner', 'input');
    const mgr = managerOf(ctx, owner.id);
    if (proposer.id !== 'owner' && proposer.id !== owner.id && !(mgr && mgr.id === proposer.id)) throw E('only ' + owner.name + ' (the routine\'s owner) or ' + (mgr ? mgr.name : 'their manager') + ' may propose its schedule', 'who');
    let want; const t = c.text.trim();
    if (t.startsWith('{')) { const j = asJson(t, '--change'); want = { expr: String(j.expr || j.schedule || ''), tz: j.tz || j.timezone || (job.schedule && job.schedule.tz) || null }; }
    else want = { expr: t, tz: (job.schedule && job.schedule.tz) || null };
    const lib = cronLib(ctx);
    if (lib && !lib.parseSchedule(want.expr, ctx.now, { tz: want.tz || undefined, defaultTz: want.tz || co.TZ })) throw E('the station cannot read the schedule "' + want.expr + '"', 'input');
    const before = { expr: (job.schedule && job.schedule.expr) || null, tz: (job.schedule && job.schedule.tz) || null };
    if (before.expr === want.expr && before.tz === want.tz) throw E('that is already the schedule', 'input');
    const reviewers = seats(ctx, [managerOf(ctx, owner.id)], proposer, [managerOf(ctx, proposer.id)]);
    return { target: { type: 'routine', jobId: job.id, jobName: job.name, owner: owner.id }, change: { schedule: want }, before: { schedule: before, firesPerDay: firesPerDay(ctx, before.expr, before.tz) }, after: { firesPerDay: firesPerDay(ctx, want.expr, want.tz) }, reviewers, applier: null, payload: null };
  }
  if (kind === 'tool') {
    const rel = String(target || '').replace(/^\.\//, '');
    const file = path.resolve(ctx.root, rel); const r2 = relOf(ctx, file);
    if (!file.startsWith(ctx.root + path.sep) || !SHARED_AREAS.some(a => r2.startsWith(a))) throw E('a tool change targets a shared file under ' + SHARED_AREAS.join(', '), 'input');
    if (r2 === 'company/tools/routine-rules.js') throw E('house rules are --kind house-rule', 'input');
    const cls = classify(ctx, r2);
    let reviewers;
    const T = ctx.crew.tools, S = ctx.crew.risk;
    let fixedGate = null;
    if (cls && cls.area === 'tool') {
      // a tool that measures, limits or protects the crew (the gates, the pacer, competence, the dispatcher, the latitude
      // tools themselves) is LOCKED: two crew seats review it, the risk and the tools holders (never the proposer; the CEO
      // stands in). The owner reviews only when fewer than two crew seats can, or when the change would edit, here, the
      // code that keeps the fixed owner gates. Governance at apply time still decides whether the owner is asked at all.
      reviewers = seats(ctx, [S, T], proposer, [ctx.crew.ceo, ctx.crew.ceo]).filter(r => r.id !== 'owner');
      if (OWNER_GATE_TOOLS[r2] && !isFrameworkFile(ctx, r2)) fixedGate = OWNER_GATE_TOOLS[r2];
      if (reviewers.length < 2 || fixedGate) reviewers.push(OWNER);
    } else if (cls) {
      // a policy number, a record, the crew list: each has its own route (a policy/model kind, its own tool)
      throw E(r2 + ' is locked (' + cls.why + '): it is owner-only and cannot be changed through a proposal' +
        (cls.area === 'policy' ? ' — a policy number is --kind policy and a model pairing is --kind model' : cls.area === 'record' || cls.area === 'state' ? ' — a record changes only through its own tool' : ' — ask the owner, who edits it directly or records the change') + ' (company/work/people/LATITUDE.md)', 'locked');
    } else reviewers = seats(ctx, [T], proposer, [S]);
    const exists = fs.existsSync(file); const cur = exists ? fs.readFileSync(file, 'utf8') : '';
    const mode = isDiff(c.text) ? 'patch' : 'replace';
    if (mode === 'patch' && !exists) throw E('a diff needs an existing file', 'input');
    const next = mode === 'patch' ? patchText(cur, c.text) : c.text;
    if (next === cur) throw E('the change leaves the file as it is', 'input');
    const bad = syntaxCheck(file, next); if (bad) throw E('the changed file does not pass its syntax check: ' + bad, 'input');
    return { target: { type: 'file', file: r2, locked: !!cls }, fixedGate: fixedGate || undefined, change: { mode, from: c.from, bytes: Buffer.byteLength(next) }, before: { sha256: exists ? sha(cur) : null, exists }, after: { sha256: sha(next) }, reviewers, applier: null, payload: { name: mode === 'patch' ? 'change.diff' : 'change.new', text: c.text } };
  }
  if (kind === 'house-rule') {
    const t = c.text.trim(); const op = t.startsWith('{') ? asJson(t, '--change') : { add: t };
    if (op.add) op.add = ruleText(ctx, op.add); if (op.replace) op.replace = { from: String(op.replace.from || ''), to: ruleText(ctx, op.replace.to) };
    const src = fs.readFileSync(ctx.paths.rules, 'utf8'); const ed = editRules(src, op);
    const bad = syntaxCheck(ctx.paths.rules, ed.src); if (bad) throw E('the edited routine-rules.js does not pass its syntax check: ' + bad, 'tool');
    const reviewers = seats(ctx, [ctx.crew.tools, ctx.crew.ceo], proposer, [ctx.crew.risk, ctx.crew.risk]);
    return { target: { type: 'file', file: 'company/tools/routine-rules.js', locked: true }, change: { rule: op, version: ed.version }, before: { sha256: sha(src) }, after: { sha256: null }, reviewers, applier: null, payload: null };
  }
  if (kind === 'model') {
    const pol = readJson(ctx.paths.modelPolicy, null); if (!pol || !pol.routing || !pol.routing.routines) throw E('company/model-policy.json has no routing table', 'tool');
    const name = String(target || '').trim(); if (!name) throw E('--target is the routine row (for example "Design loop")', 'input');
    const row = asJson(c.text.trim(), '--change');
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw E('--change is the new row, for example {"claude":"haiku","minimax":true}', 'input');
    const keys = ['claude', 'minimax', 'railOverflow', 'claudeOnlyIfShareLeftAbove', '_why'];
    for (const k of Object.keys(row)) if (!keys.includes(k)) throw E('unknown row field ' + k + ' (allowed: ' + keys.join(', ') + ')', 'input');
    const claudeKeys = Object.entries(pol.routing.models || {}).filter(([, m]) => m && m.provider === 'claude-cli').map(([k]) => k);
    if ('claude' in row && row.claude !== null && !claudeKeys.includes(row.claude)) throw E('claude must be null or one of ' + claudeKeys.join(', '), 'input');
    if ('minimax' in row && typeof row.minimax !== 'boolean') throw E('minimax must be true or false', 'input');
    const existed = pol.routing.routines[name] !== undefined;
    const before = existed ? pol.routing.routines[name] : null;
    const next = Object.assign({}, before || {}, row);
    if (same(before, next)) throw E('that is already the row', 'input');
    const hr = ctx.crew.people;
    const reviewers = seats(ctx, [hr, ctx.crew.ceo], proposer, [ctx.crew.ceo, hr]);
    const ptr = ptrStr(['routing', 'routines', name]);
    return { target: { type: 'json', file: 'company/model-policy.json', pointer: ptr }, change: { set: { [ptr]: next } }, before: { values: { [ptr]: before }, absent: existed ? [] : [ptr], sha256: fileSha(ctx.paths.modelPolicy) }, after: {}, reviewers, applier: pickName(hr), payload: null };
  }
  if (kind === 'policy') {
    const rel = policyFile(target); if (!rel) throw E('--target must be one of ' + Object.keys(POLICY_FILES).map(f => path.basename(f)).join(', '), 'input');
    const spec = POLICY_FILES[rel]; const file = ctx.P(rel);
    const doc = readJson(file, null); if (!doc) throw E(rel + ' cannot be read', 'tool');
    const set = asJson(c.text.trim(), '--change');
    if (!set || typeof set !== 'object' || Array.isArray(set) || !Object.keys(set).length) throw E('--change is {"/json/pointer": value, …}', 'input');
    const norm = {}, before = {}, absent = [];
    for (const [p, v] of Object.entries(set)) {
      const parts = ptrParts(p); const ps = ptrStr(parts);
      if (spec.only && !ps.startsWith(spec.only + '/')) throw E('in ' + rel + ' only ' + spec.only + ' is a policy number (the routing table is --kind model)', 'input');
      if (parts.some(x => /^_/.test(x))) throw E('notes (keys starting with _) are not policy numbers: edit them with the owner', 'input');
      const g = getPtr(doc, parts);
      if (!g.exists && !g.parentExists) throw E('no such place in ' + rel + ': ' + ps, 'input');
      if (g.exists && g.value !== null && v !== null && typeof g.value !== typeof v) throw E(ps + ' is a ' + typeof g.value + ', not a ' + typeof v, 'input');
      if (g.exists && g.value && typeof g.value === 'object') throw E(ps + ' is a whole section; change its numbers one by one', 'input');
      norm[ps] = v; if (g.exists) before[ps] = g.value; else absent.push(ps);
    }
    if (Object.keys(norm).every(k => (absent.includes(k) ? false : same(before[k], norm[k])))) throw E('those are already the values', 'input');
    const owner = spec.owner === 'finance' ? ctx.crew.finance : ctx.crew.people;
    const want = spec.reviewers.map(r => (r === 'finance' ? ctx.crew.finance : ctx.crew.people));
    const stand = spec.reviewers.map(r => (r === 'finance' ? (spec.reviewers.length > 1 ? ctx.crew.risk : ctx.crew.ceo) : ctx.crew.ceo));
    const reviewers = seats(ctx, want, proposer, stand);
    return { target: { type: 'json', file: rel }, change: { set: norm }, before: { values: before, absent, sha256: fileSha(file) }, after: {}, reviewers, applier: pickName(owner), payload: null };
  }
  throw E('--kind must be one of ' + KINDS.join(', '), 'input');
}

function renderSummary(ctx) {
  const recs = allRecs(ctx).reverse();
  const out = ['# Harness changes', '', 'Written by `company/tools/harness-change.js`; do not edit by hand. How it works: `company/work/people/LATITUDE.md`. Updated ' + stamp(ctx.now) + ' (company time).', '',
    '| Change | Status | Kind | Target | Proposed by | Reviewers | Why |', '|---|---|---|---|---|---|---|'];
  for (const r of recs.slice(0, 200)) {
    const rv = (r.reviewers || []).map(p => p.name + ((r.approvals || []).some(a => a.id === p.id) ? ' ✓' : (r.rejections || []).some(a => a.id === p.id) ? ' ✗' : '')).join(', ');
    out.push('| ' + r.id + ' | ' + r.status + (r.appliedAt ? ' ' + String(r.appliedAt).slice(0, 16).replace('T', ' ') : '') + ' | ' + r.kind + ' | ' + flat(targetLabel(r)).replace(/\|/g, '/') + ' | ' + r.by + ' | ' + rv + ' | ' + flat(r.why).replace(/\|/g, '/').slice(0, 160) + ' |');
  }
  if (!recs.length) out.push('| — | | | | | | |');
  writeAtomic(ctx.paths.summary, out.join('\n') + '\n');
}
const targetLabel = r => r.target.type === 'routine' ? 'routine ' + r.target.jobName : r.target.type === 'json' ? r.target.file + (r.target.pointer ? ' ' + r.target.pointer : '') : r.target.file;
function summaryLine(r) {
  if (r.kind === 'schedule' && r.target.type === 'routine') return r.before.schedule.expr + (r.before.schedule.tz ? ' (' + r.before.schedule.tz + ')' : '') + ' -> ' + r.change.schedule.expr + (r.change.schedule.tz ? ' (' + r.change.schedule.tz + ')' : '') + (r.before.firesPerDay != null ? '; runs a day ' + r.before.firesPerDay + ' -> ' + r.after.firesPerDay : '');
  if (r.kind === 'tool') return r.change.mode + ' of ' + r.target.file + (r.target.locked ? ' (a locked tool: two reviewers)' : '');
  if (r.kind === 'house-rule') { const o = r.change.rule; return o.add ? 'add: ' + o.add : o.remove ? 'remove: ' + o.remove : 'replace: ' + o.replace.from + ' -> ' + o.replace.to; }
  return Object.entries(r.change.set).map(([k, v]) => k + ': ' + JSON.stringify(r.before.values[k]) + ' -> ' + JSON.stringify(v)).join('; ');
}

/* ---------------- commands ---------------- */
// what makes two proposals the same change: the kind, the target and the exact change (the payload's bytes for a file)
function changeKeyOf(kind, d) {
  const c = Object.assign({}, d.change); delete c.from;
  return sha(JSON.stringify([kind, d.target, c, d.after || null, d.payload ? sha(d.payload.text) : null]));
}
const REPLACES_LINE = /\breplaces\s+(hc-\d{4,6})\b/i;
async function propose(ctx, o) {
  const proposer = needBy(ctx, o.by);
  const kind = String(o.kind || ''); if (!KINDS.includes(kind)) throw E('--kind must be one of ' + KINDS.join(', '), 'input');
  const why = flat(o.why).trim(); if (why.length < 20) throw E('--why must say why, in at least 20 characters', 'input');
  if (kind !== 'house-rule' && (o.target == null || o.target === true)) throw E('--target is required', 'input');
  const plain = o.plain && o.plain !== true ? flat(o.plain).trim().slice(0, 300) : null;
  const d = await describe(ctx, kind, o.target, o.change, proposer);
  const changeKey = changeKeyOf(kind, d);
  // the same change from the same person, still open: update that record, never a second one (and never a second card)
  const again = allRecs(ctx).find(r => r.byId === proposer.id && r.changeKey === changeKey && ['proposed', 'approved'].includes(r.status));
  if (again) {
    return withLock(ctx, () => {
      const rec = loadRec(ctx, again.id);
      if (rec.status === 'proposed') { rec.why = why; if (o.expect) rec.expect = flat(o.expect).slice(0, 300); if (plain) rec.plain = plain; }
      hist(ctx, rec, 'proposed again', proposer.name); saveRec(ctx, rec);
      appendLog(ctx, { event: 'proposed-again', id: rec.id, by: proposer.name, claim: 'unverified', underStation: ctx.underStation });
      renderSummary(ctx);
      return Object.assign(rec, { again: true });
    });
  }
  // --replaces hc-NNNN (or a "Replaces hc-NNNN" line in --why): the old change and its owner card are withdrawn first
  const asked = o.replaces && o.replaces !== true ? String(o.replaces).trim() : null;
  const fromWhy = !asked && REPLACES_LINE.exec(why);
  const replaces = asked || (fromWhy ? fromWhy[1] : null);
  if (replaces) {
    const old = readJson(recFile(ctx, replaces), null);
    if (!old && asked) throw E('--replaces ' + replaces + ': no such change', 'input');
    if (old && ['proposed', 'approved'].includes(old.status)) {
      if (old.byId !== proposer.id) { if (asked) throw E('--replaces ' + replaces + ': only ' + old.by + ' may withdraw it', 'who'); }
      else withdraw(ctx, replaces, { by: o.by, why: 'replaced by a new proposal' });
    }
  }
  return withLock(ctx, () => {
    const id = nextId(ctx);
    const rec = Object.assign({ v: 1, id, kind, why, expect: o.expect ? flat(o.expect).slice(0, 300) : null, plain: plain || undefined, replaces: replaces || undefined, changeKey,
      by: proposer.name, byId: proposer.id, claim: 'unverified', underStation: ctx.underStation,
      proposedAt: local(ctx.now), status: 'proposed', approvals: [], rejections: [], history: [] }, d);
    delete rec.payload;
    if (d.payload) { const pf = path.join(ctx.paths.dir, id, d.payload.name); writeAtomic(pf, d.payload.text); rec.change.payload = relOf(ctx, pf); }
    hist(ctx, rec, 'proposed', proposer.name);
    if (rec.reviewers.some(r => r.id === 'owner')) rec.ownerRef = 'harness-review:' + id;
    saveRec(ctx, rec);
    appendLog(ctx, { event: 'proposed', id, kind, target: targetLabel(rec), by: proposer.name, claim: 'unverified', underStation: ctx.underStation, reviewers: rec.reviewers.map(p => p.name), replaces: replaces || undefined });
    for (const p of rec.reviewers) if (p.id !== 'owner') handoff(ctx, p, 'review ' + id + ' (' + kind + ': ' + targetLabel(rec) + ') proposed by ' + proposer.name, {
      Need: 'review this change and decide: ' + cmdFor('approve', rec, p, ' --note "…"') + ' or ' + cmdFor('reject', rec, p, ' --note "why not"') + '. See it with `node company/tools/harness-change.js show ' + id + '`.',
      Why: why + (rec.expect ? ' Expected effect: ' + rec.expect : ''), Deadline: local(ctx.now + 2 * 86400e3).slice(0, 10), Status: 'OPEN',
      Evidence: summaryLine(rec) + ' — `company/work/changes/' + id + '.json`' });
    // the owner is the only reviewer (nobody else on the crew can review): their card goes out now; otherwise it waits
    // for the crew's reviews, so the owner sees what colleagues already checked
    if (rec.reviewers.every(r => r.id === 'owner')) { ownerTurn(ctx, rec, 'review'); saveRec(ctx, rec); }
    renderSummary(ctx);
    return rec;
  });
}
/* ownerTurn(ctx, rec, stage) — the crew's part is done and the owner is next: file the card. When owner-card hands it
 * back (governance or a standing owner ruling lets the crew decide), the owner's seat is dropped from the reviewers and
 * the record says why; at stage 'apply' the change may then be applied. Mutates rec; the caller saves it. */
function ownerTurn(ctx, rec, stage) {
  const r = ownerCard(ctx, rec, stage);
  if (!coveredByCrew(r)) return r;
  rec.ownerWaived = { stage, route: r.route, reason: r.reason || null, at: local(ctx.now) };
  hist(ctx, rec, 'owner not asked', TOOL_NAME, (r.reason || r.route) + ': the crew decides');
  if (stage === 'review') {
    rec.reviewers = rec.reviewers.filter(x => x.id !== 'owner');
    // nobody else on the crew could review: the proposer applies, under the level the owner set (recorded, unreviewed)
    if (!rec.reviewers.length) { rec.applier = pickName(person(ctx, rec.by)); rec.unreviewed = true; }
    if (rec.reviewers.every(x => rec.approvals.some(a => a.id === x.id))) {
      rec.status = 'approved'; rec.approvedAt = local(ctx.now);
      if (rec.target.type === 'json' || rec.target.type === 'file') rec.approvedSha = fileSha(ctx.P(rec.target.file));
      if (rec.target.type === 'json') { try { rec.approvedDoc = JSON.parse(fs.readFileSync(ctx.P(rec.target.file), 'utf8')); } catch (_) { rec.approvedDoc = null; } }
      const doer = rec.applier ? person(ctx, rec.applier.name) : person(ctx, rec.reviewers[rec.reviewers.length - 1].name);
      if (doer) handoff(ctx, doer, 'apply ' + rec.id + ' (' + rec.kind + ': ' + targetLabel(rec) + ')', { Need: 'apply it: ' + cmdFor('apply', rec, doer) + ' (the owner\'s self-governance lets the crew decide this one).', Why: rec.why, Deadline: local(ctx.now + 2 * 86400e3).slice(0, 10), Status: 'OPEN', Evidence: summaryLine(rec) + ' — `company/work/changes/' + rec.id + '.json`' });
    }
  }
  return r;
}
function review(ctx, id, o, verdict) {
  return withLock(ctx, () => {
    const rec = loadRec(ctx, id); const p = o.viaConsole ? OWNER : needBy(ctx, o.by);
    if (rec.status !== 'proposed') throw E(id + ' is ' + rec.status + '; only a proposed change can be reviewed', 'state');
    if (p.id === rec.byId) throw E('nobody reviews their own proposal', 'who');
    if (p.id !== 'owner' && !rec.reviewers.some(r => r.id === p.id)) throw E(p.name + ' is not a reviewer of ' + id + ' (' + rec.reviewers.map(r => r.name).join(', ') + ')', 'who');
    if (rec.approvals.some(a => a.id === p.id)) throw E(p.name + ' already approved ' + id, 'state');
    const note = o.note && o.note !== true ? flat(o.note).slice(0, 400) : '';
    if (verdict === 'reject' && note.length < 5) throw E('--note must say why it is rejected', 'input');
    const entry = { id: p.id, name: p.name, at: local(ctx.now), note: note || undefined, claim: 'unverified', underStation: ctx.underStation };
    if (verdict === 'approve') rec.approvals.push(entry); else rec.rejections.push(entry);
    hist(ctx, rec, verdict === 'approve' ? 'approved' : 'rejected', p.name, note);
    if (verdict === 'reject') {
      rec.status = 'rejected';
      closeHandoffs(ctx, 'review ' + id + ' ', 'rejected by ' + p.name + ' ' + stamp(ctx.now));
      handoff(ctx, person(ctx, rec.by), id + ' rejected by ' + p.name, { Need: 'nothing; propose again if you change it.', Why: note, Deadline: 'none', Status: 'DONE — FYI', Evidence: '`company/work/changes/' + id + '.json`' });
    } else if (rec.reviewers.every(r => rec.approvals.some(a => a.id === r.id))) {
      rec.status = 'approved'; rec.approvedAt = local(ctx.now);
      if (rec.target.type === 'json' || rec.target.type === 'file') rec.approvedSha = fileSha(ctx.P(rec.target.file));
      // for a policy/model change, remember the whole file as approved, so apply can tell the approved edit from any OTHER
      // edit that rode in with it (the watcher accepts only the approved-only content, never the whole file blind).
      if (rec.target.type === 'json') { try { rec.approvedDoc = JSON.parse(fs.readFileSync(ctx.P(rec.target.file), 'utf8')); } catch (_) { rec.approvedDoc = null; } }
      closeHandoffs(ctx, 'review ' + id + ' ', 'approved by ' + rec.approvals.map(a => a.name).join(', ') + ' ' + stamp(ctx.now));
      // reviewed: when the change's category is at approve and the owner has not said yes to this very change, the owner
      // is next (one card, filed now); the dispatcher applies it after their yes, so nobody is handed an apply to run
      const waitsForOwner = !ownerSaidYesTo(ctx, rec) && gov.level(governanceCategory(rec), { root: ctx.root }) === 'approve' && !coveredByCrew(ownerTurn(ctx, rec, 'apply'));
      const doer = rec.applier ? person(ctx, rec.applier.name) : p;
      // the owner approved on Today: ownerDecisions() applies it now, nobody is asked to run anything
      const how = o.viaConsole || waitsForOwner ? null : rec.applier
        ? 'apply it: make the approved edit in `' + rec.target.file + '` yourself and then run ' + cmdFor('apply', rec, doer) + ' to record it, or just run that command and the tool makes exactly the approved edit for you'
        : 'apply it: ' + cmdFor('apply', rec, doer) + ' (any reviewer may apply)';
      if (how) handoff(ctx, doer, 'apply ' + id + ' (' + rec.kind + ': ' + targetLabel(rec) + ')', { Need: how + '.', Why: rec.why, Deadline: local(ctx.now + 2 * 86400e3).slice(0, 10), Status: 'OPEN', Evidence: summaryLine(rec) + ' — `company/work/changes/' + id + '.json`' });
    } else {
      closeHandoffs(ctx, 'review ' + id + ' (', 'approved by ' + p.name + ' ' + stamp(ctx.now) + '; waiting for the other reviewer', p);
      // every crew review is in and only the owner's is left: the owner's card goes out now (once)
      const crewDone = rec.reviewers.filter(r => r.id !== 'owner').every(r => rec.approvals.some(a => a.id === r.id));
      if (verdict === 'approve' && crewDone && rec.reviewers.some(r => r.id === 'owner') && !(rec.ownerCard && rec.ownerCard.filed)) ownerTurn(ctx, rec, 'review');
    }
    saveRec(ctx, rec);
    appendLog(ctx, { event: verdict === 'approve' ? 'approved' : 'rejected', id, by: p.name, claim: 'unverified', underStation: ctx.underStation, status: rec.status });
    renderSummary(ctx);
    return rec;
  });
}
function withdraw(ctx, id, o) {
  return withLock(ctx, () => {
    const rec = loadRec(ctx, id); const p = needBy(ctx, o.by);
    if (p.id !== rec.byId && p.id !== 'owner') throw E('only ' + rec.by + ' may withdraw ' + id, 'who');
    if (!['proposed', 'approved'].includes(rec.status)) throw E(id + ' is ' + rec.status, 'state');
    rec.status = 'withdrawn'; hist(ctx, rec, 'withdrawn', p.name, o.why && o.why !== true ? flat(o.why).slice(0, 200) : undefined);
    closeHandoffs(ctx, id + ' ', 'withdrawn by ' + p.name + ' ' + stamp(ctx.now));
    withdrawCard(ctx, rec, p.id, (o.why && o.why !== true ? flat(o.why) : 'withdrawn by ' + p.name).slice(0, 200));   // the owner's card goes too
    saveRec(ctx, rec); appendLog(ctx, { event: 'withdrawn', id, by: p.name, claim: 'unverified', underStation: ctx.underStation }); renderSummary(ctx);
    return rec;
  });
}
function mayApply(ctx, rec, p) {
  if (p.id === 'owner') return;
  if (rec.applier) { if (p.id !== rec.applier.id) throw E(rec.target.file + ' is ' + rec.applier.name + '\'s file: ' + rec.applier.name + ' applies ' + rec.id, 'who'); return; }
  if (!rec.reviewers.some(r => r.id === p.id)) throw E('a reviewer applies ' + rec.id + ' (' + rec.reviewers.map(r => r.name).join(', ') + ')', 'who');
}
// which self-governance category an applied change falls under: the budget files are budget, the rest of the policy
// numbers and every tool or house-rule change are tools, a routing-table row is models, a routine clock is schedules
const BUDGET_FILES = ['company/work/finance/pacing-policy.json', 'company/work/finance/dispatch-budget.json'];
function governanceCategory(rec) {
  if (rec.kind === 'schedule') return 'schedules';
  if (rec.kind === 'model') return 'models';
  if (rec.kind === 'policy' && rec.target && BUDGET_FILES.includes(rec.target.file)) return 'budget';
  return 'tools';
}
function backupDir(ctx, rec) { return path.join(ctx.paths.dir, rec.id, 'before'); }

const OWNED_FILES = new Set(['company/company.json', 'company/CHARTER.md', 'company/competence-policy.json', 'company/model-policy.json', 'company/tools/loops.json']);
function requestPayload(ctx, rec) {
  const rel = rec && rec.change && rec.change.payload;
  if (!rel) return '';
  try { return fs.readFileSync(ctx.P(rel), 'utf8'); } catch (_) { return ''; }
}
// one sequence with lib/framework-edits.js (fr-0007.md and a hand-written fr-0007-title.md count alike)
function nextFrameworkRequestId(dir) { return require('./lib/framework-edits').nextRequestId(dir); }
// true when `file` is a framework file of a founded company checkout: a change to it is sent upstream, never applied here
function isFrameworkFile(ctx, file) {
  if (!file || OWNED_FILES.has(file)) return false;
  if (!fs.existsSync(path.join(ctx.root, 'company', 'work', '.founded'))) return false;   // the framework checkout applies its own changes
  const cpx = require('child_process');
  const top = cpx.spawnSync('git', ['-C', ctx.root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  let real = ctx.root; try { real = fs.realpathSync(ctx.root); } catch (_) {}
  if (top.status !== 0 || top.stdout.trim() !== real) return false;   // not its own checkout (e.g. a test copy inside another repo)
  return cpx.spawnSync('git', ['-C', ctx.root, 'ls-files', '--error-unmatch', '--', file], { stdio: 'ignore' }).status === 0;   // else a company-only file
}
function frameworkRequest(ctx, rec, p) {
  const file = rec && rec.target && rec.target.file;
  if (!file || !['tool', 'house-rule', 'policy'].includes(rec.kind) || !isFrameworkFile(ctx, file)) return null;
  const dir = path.join(ctx.root, 'company', 'work', 'framework-requests'); fs.mkdirSync(dir, { recursive: true });
  // framework requests have their own sequence (fr-0001, ...): the company's hc ids are per company and would collide in
  // the framework's queue; each request names the company change it came from
  const frId = rec.frameworkRequest || nextFrameworkRequestId(dir);
  const out = path.join(dir, frId + '.md');
  // the proposal's diff/body is stored at rec.change.payload (relative to the root); the request carries it in full
  const payload = requestPayload(ctx, rec);
  if (!payload.trim()) throw E(rec.id + ': no change text to send to the framework (the proposal has no payload); propose it again with the diff', 'state');
  fs.writeFileSync(out, '# Framework change request ' + frId + '\n\n- Company change: ' + rec.id + ' (company/work/changes/' + rec.id + '.json)\n- File: `' + file + '`\n- Proposed by: ' + rec.by + '; reviewed by: ' + ((rec.approvals || []).map(a => a.name).join(', ') || '-') + '\n- Why: ' + rec.why + '\n\nThis file belongs to the CaPheOS framework, so the change was not applied in this company. Forward it to the framework (it reaches this company with the next update).\n\n```diff\n' + payload.slice(0, 60000) + '\n```\n');
  rec.status = 'upstream'; rec.upstreamAt = new Date(ctx.now).toISOString(); rec.frameworkRequest = frId; saveRec(ctx, rec);
  appendLog(ctx, { event: 'upstream', id: rec.id, frameworkRequest: frId, by: p.name, file, request: path.relative(ctx.root, out) });
  // the owner hears of it once, in the daily digest, in plain words; the file and the request are for the crew
  tellOwner(ctx, { from: rec.by, key: 'harness-upstream:' + rec.id,
    text: rec.by + ' sent the makers of the company software an improvement to ' + plainArea(rec) + ', ' + afterWords(rec) + '.',
    technical: rec.id + ': ' + file + ' — ' + rec.why + ' Request: ' + path.relative(ctx.root, out) + ' (framework files change only through framework updates).' });
  return Object.assign({}, rec, { applied: false, upstream: path.relative(ctx.root, out) });
}

async function applyChange(ctx, id, o) {
  const p = o.viaConsole ? OWNER : needBy(ctx, o.by);
  const rec0 = loadRec(ctx, id);
  // Guardrail harnessSelfEdit OFF (company/state/guardrails.json): a proposed change may be applied by its proposer or
  // anyone on the crew without its reviews; the record still says who applied it unreviewed.
  const unguarded = !co.guard('harnessSelfEdit') && rec0.status === 'proposed';
  if (rec0.status !== 'approved' && !unguarded) throw E(id + ' is ' + rec0.status + '; only an approved change is applied', 'state');
  if (unguarded) { appendLog(ctx, { event: 'applied-unreviewed', id, by: p.name, why: 'harnessSelfEdit guardrail off' }); rec0.status = 'approved'; rec0.unreviewed = true; }
  else mayApply(ctx, rec0, p);
  // self-governance, at apply time (company/state/governance.json, lib/governance.js): the reviewed change still needs
  // the owner when its category is at approve, and the owner is told when it is at notify
  const govCat = governanceCategory(rec0);
  const ownerSaidYes = ownerSaidYesTo(ctx, rec0);   // the owner said yes to this very change: no second question
  const lv = ownerSaidYes ? 'owner' : gov.level(govCat, { root: ctx.root, triage: true });
  let tellAfter = false;
  if (lv === 'notify') tellAfter = true;
  else if (lv === 'triage') {
    const gd = gov.decide(govCat, { by: p.name, ref: 'harness:' + rec0.id, summary: 'apply ' + rec0.id + ', a ' + rec0.kind + ' change to ' + targetLabel(rec0) + ' (' + summaryLine(rec0) + ')',
      recommendation: 'yes: reviewed and approved by ' + ((rec0.approvals || []).map(x => x.name).join(' and ') || 'its reviewers') + '; why: ' + rec0.why, default: 'the change stays approved but not applied' }, { root: ctx.root });
    if (!gd.allowed) throw E(gov.refusal(govCat, gd), 'refused');
  } else if (lv === 'approve') {
    // one owner card for this change (filed at the last review; filed now when the level was raised since): the apply
    // waits for the owner's yes, which the dispatcher acts on; a no rejects it there
    const said = rec0.ownerRef ? gov.approved(rec0.ownerRef, { root: ctx.root }) : null;
    if (said === false) throw E('the owner said no to ' + rec0.id + '; it is not applied', 'refused');
    if (!(rec0.ownerWaived && rec0.ownerWaived.stage === 'apply')) {
      const r = withLock(ctx, () => { const rec = loadRec(ctx, id); const x = ownerTurn(ctx, rec, 'apply'); saveRec(ctx, rec); return x; });
      if (!coveredByCrew(r)) throw E('self-governance: ' + govCat + ' is at approve, so ' + rec0.id + ' waits for the owner' + (r.filed || r.route === 'duplicate' ? ' (their card is on Today; it is applied after their yes, nobody needs to run apply again)' : ' (the owner card could not be filed: ' + (r.reason || r.route) + ')'), 'refused');
    }
  }
  // In a company checkout (founded), a change to a FRAMEWORK file (tracked in git, not one of the files a company owns)
  // is not applied in place: it would collide with every framework update and differ from every other company. It
  // becomes an upstream request the owner forwards to the framework; company-only tools and company files apply as usual.
  const up = frameworkRequest(ctx, rec0, p);
  if (up) return up;
  let result;
  if (rec0.kind === 'schedule' && rec0.target.type === 'routine') {
    const jobs = await jobsNow(ctx); const job = jobs.find(j => j.id === rec0.target.jobId);
    if (!job) throw E('routine ' + rec0.target.jobName + ' no longer exists', 'state');
    const cur = { expr: (job.schedule && job.schedule.expr) || null, tz: (job.schedule && job.schedule.tz) || null };
    if (cur.expr !== rec0.before.schedule.expr) throw E('the schedule changed since the proposal (' + rec0.before.schedule.expr + ' -> ' + cur.expr + '); propose again', 'stale');
    const patch = { schedule: rec0.change.schedule.expr }; if (rec0.change.schedule.tz) patch.timezone = rec0.change.schedule.tz;
    const r = await ctx.call('POST', '/api/cron/update', { id: job.id, patch });
    const v = require('./lib/station').cronResult(r, 'POST /api/cron/update');   // a 200 can be a decline
    if (!v.ok) throw E('the station refused the schedule (' + v.reason + ')', 'station');
    let after = null; try { const j = JSON.parse(r.body).job; after = j && j.schedule ? { expr: j.schedule.expr, tz: j.schedule.tz || null } : null; } catch (_) {}
    result = { schedule: after || rec0.change.schedule };
  } else if (rec0.kind === 'tool' || rec0.kind === 'house-rule') {
    const target = ctx.P(rec0.target.file);
    const cur = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    if ((fs.existsSync(target) ? sha(cur) : null) !== rec0.before.sha256) throw E(rec0.target.file + ' changed since the proposal; propose again on the current file', 'stale');
    let next;
    if (rec0.kind === 'tool') next = rec0.change.mode === 'patch' ? patchText(cur, fs.readFileSync(ctx.P(rec0.change.payload), 'utf8')) : fs.readFileSync(ctx.P(rec0.change.payload), 'utf8');
    else next = editRules(cur, rec0.change.rule).src;
    const bad = syntaxCheck(target, next); if (bad) throw E('syntax check failed: ' + bad, 'tool');
    const st = runSelftest(ctx, target, next); if (st) throw E('not applied: ' + st, 'tool');
    if (rec0.kind === 'house-rule') {   // the new rules must be what was approved
      const v = /const VERSION = '(v\d+)';/.exec(next); if (!v || v[1] !== rec0.change.version) throw E('the new house-rules version is not ' + rec0.change.version, 'tool');
    }
    const bdir = backupDir(ctx, rec0); fs.mkdirSync(bdir, { recursive: true });
    const had = fs.existsSync(target); const mode = had ? fs.statSync(target).mode & 0o777 : 0o644;
    if (had) writeAtomic(path.join(bdir, path.basename(target)), cur);
    writeAtomic(target, next, 'harness-change.js ' + id);
    try { fs.chmodSync(target, mode); } catch (_) {}
    if (path.basename(target) === 'dispatch.js' && !ctx.skipSelftest) {   // the dispatcher must still run: a dry tick, else put it back
      try { execFileSync('node', [target, '--dry-run'], { cwd: ctx.root, stdio: 'pipe', timeout: 120000 }); }
      catch (e) { writeAtomic(target, cur, 'harness-change.js ' + id + ' (restored)'); throw E('dispatch.js --dry-run failed after the change, so the old file is back: ' + String(e.message).slice(0, 200), 'tool'); }
    }
    result = { sha256: sha(next), backup: had ? relOf(ctx, path.join(bdir, path.basename(target))) : null };
  } else {
    const file = ctx.P(rec0.target.file); const txt = fs.readFileSync(file, 'utf8'); const doc = JSON.parse(txt);
    const has = Object.entries(rec0.change.set).every(([k, v]) => same(getPtr(doc, ptrParts(k)).value, v));
    const was = Object.entries(rec0.before.values).every(([k, v]) => same(getPtr(doc, ptrParts(k)).value, v));
    const bdir = backupDir(ctx, rec0); fs.mkdirSync(bdir, { recursive: true });
    // the ONLY change this record may carry is the approved pointer-set. Compute what the file should be — the file as it was
    // when approved, with exactly the approved pointers set — and require the current file to match it. Any other edit (a
    // second policy number quietly changed in the same breath) makes them differ, and apply refuses rather than record it.
    const expected = rec0.approvedDoc != null ? JSON.parse(JSON.stringify(rec0.approvedDoc)) : null;
    if (expected) { for (const [k, v] of Object.entries(rec0.change.set)) setPtr(expected, ptrParts(k), v); }
    let how;
    if (has) {
      if (expected && !same(doc, expected)) throw E(rec0.target.file + ' has edits beyond the approved change (' + Object.keys(rec0.change.set).join(', ') + '): the apply would record the whole file. Put the other edits back, or propose them too', 'stale');
      how = 'recorded ' + p.name + '\'s own edit'; writeAtomic(path.join(bdir, 'values.json'), JSON.stringify(rec0.before.values, null, 1) + '\n');
    } else if (was) {
      if (expected && !same(doc, rec0.approvedDoc)) throw E(rec0.target.file + ' changed since it was approved (beyond the approved pointers): propose again on the current file', 'stale');
      writeAtomic(path.join(bdir, path.basename(file)), txt);
      const base = expected || doc; if (!expected) for (const [k, v] of Object.entries(rec0.change.set)) setPtr(base, ptrParts(k), v);
      const out = JSON.stringify(base, null, indentOf(txt)) + (txt.endsWith('\n') ? '\n' : '');
      writeAtomic(file, out, 'harness-change.js ' + id + ' for ' + p.name);
      how = 'made the approved edit for ' + p.name;
    } else throw E(rec0.target.file + ' has neither the old nor the approved values at ' + Object.keys(rec0.change.set).join(', ') + '; edit it to the approved values or propose again', 'stale');
    result = { sha256: fileSha(file), how };
  }
  return withLock(ctx, () => {
    const rec = loadRec(ctx, id);
    rec.status = 'applied'; rec.appliedAt = local(ctx.now); rec.appliedAtMs = ctx.now; rec.appliedBy = p.name; rec.applied = result; rec.judgeAfter = local(ctx.now + RESULTS_AFTER_DAYS * 86400e3);
    hist(ctx, rec, 'applied', p.name, result.how);
    saveRec(ctx, rec);
    appendLog(ctx, { event: 'applied', id, kind: rec.kind, target: targetLabel(rec), by: p.name, claim: 'unverified', underStation: ctx.underStation, sha256: result.sha256 || undefined });
    closeHandoffs(ctx, 'apply ' + id + ' ', 'applied by ' + p.name + ' ' + stamp(ctx.now));
    if (tellAfter) tellOwner(ctx, { from: rec.by, key: 'harness-applied:' + rec.id, text: rec.by + ' changed ' + plainArea(rec) + ', ' + afterWords(rec) + '.',
      technical: rec.id + ' (' + rec.kind + ': ' + targetLabel(rec) + ') applied by ' + p.name + ': ' + summaryLine(rec) + '. Why: ' + rec.why + ' Self-governance has ' + govCat + ' at notify.' });
    if (rec.byId !== p.id) handoff(ctx, person(ctx, rec.by), id + ' applied (' + rec.kind + ': ' + targetLabel(rec) + ')', { Need: 'nothing; the results are checked on ' + rec.judgeAfter.slice(0, 10) + '.', Why: rec.why, Deadline: 'none', Status: 'DONE — FYI', Evidence: summaryLine(rec) });
    if (rec.kind === 'schedule' && rec.after.firesPerDay != null && rec.before.firesPerDay != null && rec.after.firesPerDay > rec.before.firesPerDay && ctx.crew.finance)
      handoff(ctx, ctx.crew.finance, 'FYI: ' + rec.target.jobName + ' now runs more often (' + rec.before.firesPerDay + ' -> ' + rec.after.firesPerDay + ' a day), ' + id, { Need: 'nothing unless the usage pacing needs it.', Why: rec.why, Deadline: 'none', Status: 'DONE — FYI', Evidence: '`company/work/changes/' + id + '.json`' });
    renderSummary(ctx);
    return rec;
  });
}
async function revertChange(ctx, id, o) {
  const p = needBy(ctx, o.by);
  const rec0 = loadRec(ctx, id);
  if (rec0.status !== 'applied' && rec0.status !== 'kept') throw E(id + ' is ' + rec0.status + '; only an applied change is reverted', 'state');
  if (p.id !== 'owner' && !(rec0.applier ? p.id === rec0.applier.id : rec0.reviewers.some(r => r.id === p.id))) throw E((rec0.applier ? rec0.applier.name : 'a reviewer (' + rec0.reviewers.map(r => r.name).join(', ') + ')') + ' reverts ' + id, 'who');
  let result;
  if (rec0.kind === 'schedule' && rec0.target.type === 'routine') {
    const jobs = await jobsNow(ctx); const job = jobs.find(j => j.id === rec0.target.jobId);
    if (!job) throw E('routine ' + rec0.target.jobName + ' no longer exists', 'state');
    const cur = (job.schedule && job.schedule.expr) || null;
    if (cur !== rec0.applied.schedule.expr) throw E('the schedule changed again since ' + id + ' (' + cur + '); not reverted', 'stale');
    const patch = { schedule: rec0.before.schedule.expr }; if (rec0.before.schedule.tz) patch.timezone = rec0.before.schedule.tz;
    const r = await ctx.call('POST', '/api/cron/update', { id: job.id, patch });
    const v = require('./lib/station').cronResult(r, 'POST /api/cron/update');
    if (!v.ok) throw E('the station refused (' + v.reason + ')', 'station');
    result = { schedule: rec0.before.schedule };
  } else if (rec0.kind === 'tool' || rec0.kind === 'house-rule') {
    const target = ctx.P(rec0.target.file);
    if (fileSha(target) !== rec0.applied.sha256) throw E(rec0.target.file + ' changed since ' + id + ' was applied; not reverted (propose a new change)', 'stale');
    if (!rec0.applied.backup) { fs.unlinkSync(target); result = { removed: true }; }
    else { const old = fs.readFileSync(ctx.P(rec0.applied.backup)); const mode = fs.statSync(target).mode & 0o777; writeAtomic(target, old, 'harness-change.js revert ' + id); try { fs.chmodSync(target, mode); } catch (_) {} result = { sha256: sha(old) }; }
  } else {
    const file = ctx.P(rec0.target.file); const txt = fs.readFileSync(file, 'utf8'); const doc = JSON.parse(txt);
    if (!Object.entries(rec0.change.set).every(([k, v]) => same(getPtr(doc, ptrParts(k)).value, v))) throw E(rec0.target.file + ' no longer has the values ' + id + ' set; not reverted', 'stale');
    for (const [k, v] of Object.entries(rec0.before.values)) setPtr(doc, ptrParts(k), v);
    for (const k of (rec0.before.absent || [])) setPtr(doc, ptrParts(k), undefined);   // a key the change added and that was not there before is removed, not left as null
    const out = JSON.stringify(doc, null, indentOf(txt)) + (txt.endsWith('\n') ? '\n' : '');
    writeAtomic(file, out, 'harness-change.js revert ' + id + ' for ' + p.name);
    result = { sha256: sha(out) };
  }
  return withLock(ctx, () => {
    const rec = loadRec(ctx, id);
    rec.status = 'reverted'; rec.revertedAt = local(ctx.now); rec.revertedBy = p.name; rec.reverted = result; rec.revertWhy = o.why && o.why !== true ? flat(o.why).slice(0, 300) : null;
    hist(ctx, rec, 'reverted', p.name, rec.revertWhy);
    saveRec(ctx, rec);
    appendLog(ctx, { event: 'reverted', id, by: p.name, claim: 'unverified', underStation: ctx.underStation, sha256: result.sha256 || undefined });
    closeHandoffs(ctx, id + ' ', 'reverted by ' + p.name + ' ' + stamp(ctx.now));
    if (rec.byId !== p.id) handoff(ctx, person(ctx, rec.by), id + ' reverted by ' + p.name, { Need: 'nothing; propose again with what you learned if it is still worth doing.', Why: rec.revertWhy || 'results got worse', Deadline: 'none', Status: 'DONE — FYI', Evidence: '`company/work/changes/' + id + '.json`' });
    renderSummary(ctx);
    return rec;
  });
}
function keepChange(ctx, id, o) {
  return withLock(ctx, () => {
    const rec = loadRec(ctx, id); const p = needBy(ctx, o.by);
    if (rec.status !== 'applied') throw E(id + ' is ' + rec.status, 'state');
    const may = p.id === 'owner' || (rec.applier && rec.applier.id === p.id) || rec.reviewers.some(r => r.id === p.id);
    if (!may) throw E('a reviewer decides the results check of ' + id, 'who');
    rec.status = 'kept'; rec.keptAt = local(ctx.now); rec.keptBy = p.name; rec.keepNote = o.note && o.note !== true ? flat(o.note).slice(0, 300) : null;
    hist(ctx, rec, 'kept', p.name, rec.keepNote); saveRec(ctx, rec);
    appendLog(ctx, { event: 'kept', id, by: p.name, claim: 'unverified', underStation: ctx.underStation });
    closeHandoffs(ctx, 'results check ' + id + ' ', 'kept by ' + p.name + ' ' + stamp(ctx.now));
    renderSummary(ctx);
    return rec;
  });
}

/* ---------------- results check ---------------- */
// same buckets as company/tools/model-stats.js (house benchmarks), over a time window instead of the last 14 days
const kindOf = r => (r.outcome === 'refused' || r.failureCode === 'content_policy_blocked' || r.reason === 'refusal') ? 'refused' : r.reason === 'done' ? 'finished' : r.reason === 'max_iters' ? 'outOfSteps' : r.reason === 'budget' ? 'outOfBudget' : (r.reason === 'error' || r.reason === 'empty') ? 'providerError' : (r.reason === 'cancelled' || r.reason === 'interrupted') ? 'stopped' : 'other';
const median = xs => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function stat(list) {
  const c = { runs: list.length, finished: 0, refused: 0, outOfSteps: 0, outOfBudget: 0, providerError: 0, stopped: 0, other: 0 };
  for (const r of list) c[kindOf(r)]++;
  const judged = c.runs - c.providerError - c.stopped - c.outOfBudget;
  const done = list.filter(r => kindOf(r) === 'finished');
  return Object.assign(c, { judged, finishRate: judged ? Math.round(100 * c.finished / judged) : null, medianMinutes: median(done.map(r => (r.durationMs || 0) / 60000)),
    medianTokens: median(done.map(r => r.tokens || 0)), models: [...new Set(list.map(r => (r.provider || '?') + '/' + (r.model || '?')))] });
}
// the last 60 days only, read from the end (lib/bounded.js): a results check compares 14 days before an apply with 3 after
function readRuns(ctx) { const out = []; let txt = ''; try { fs.statSync(ctx.paths.runs); txt = require('./lib/bounded').jsonlWindowText(ctx.paths.runs, (ctx.now || Date.now()) - 60 * 86400e3); } catch (_) { return out; } for (const l of txt.split('\n')) { if (!l) continue; try { const r = JSON.parse(l); if (r && r.cronJobId && Number(r.startedAt)) out.push(r); } catch (_) {} } return out; }
function results(ctx, rec, runs) {
  const at = Number(rec.appliedAtMs) || Date.parse(rec.appliedAt);
  const scope = rec.kind === 'schedule' || rec.kind === 'model'
    ? { label: 'routine ' + (rec.target.jobName || rec.target.pointer), match: r => (rec.target.jobId ? r.cronJobId === rec.target.jobId : false) }
    : { label: 'all routine runs', match: () => true };
  if (rec.kind === 'model') { const name = ptrParts(rec.target.pointer).pop(); scope.label = 'routines matching "' + name + '"'; scope.match = r => String(r._routine || '').startsWith(name); }
  const before = stat(runs.filter(r => scope.match(r) && r.startedAt >= at - 14 * 86400e3 && r.startedAt < at));
  const after = stat(runs.filter(r => scope.match(r) && r.startedAt >= at && r.startedAt <= ctx.now));
  let verdict = 'about the same', notes = [];
  if (after.judged < 5 || before.judged < 5) verdict = 'too few runs to judge (' + before.judged + ' before, ' + after.judged + ' after; at least 5 each)';
  else {
    if (before.finishRate - after.finishRate >= 15) { verdict = 'worse'; notes.push('finish rate ' + before.finishRate + '% -> ' + after.finishRate + '%'); }
    if (before.medianMinutes && after.medianMinutes && after.medianMinutes >= 1.5 * before.medianMinutes && after.medianMinutes > 60) { verdict = 'worse'; notes.push('median minutes ' + before.medianMinutes.toFixed(1) + ' -> ' + after.medianMinutes.toFixed(1)); }
    if (after.refused / after.runs > before.refused / Math.max(1, before.runs) && after.refused > before.refused) { verdict = 'worse'; notes.push('refusals ' + before.refused + ' -> ' + after.refused); }
    if (verdict !== 'worse' && after.finishRate - before.finishRate >= 10) verdict = 'better';
  }
  const confounded = before.models.join(',') !== after.models.join(',') && (before.runs && after.runs) ? 'the runs used different models before and after (' + before.models.join(', ') + ' vs ' + after.models.join(', ') + '): read with care' : null;
  return { scope: scope.label, before, after, verdict, notes, confounded };
}
const fmtStat = s => s.runs + ' runs, finish rate ' + (s.finishRate == null ? '–' : s.finishRate + '%') + ' (' + s.judged + ' judged), refused ' + s.refused + ', out of steps ' + s.outOfSteps + ', median ' + (s.medianMinutes == null ? '–' : s.medianMinutes.toFixed(1)) + ' min';
function dueList(ctx) {
  const runs = readRuns(ctx);
  const names = {}; try { for (const j of (readJson(ctx.P('.starnet-data/workspaces/cron.jobs.json'), {}).jobs || [])) names[j.id] = j.name; } catch (_) {}
  for (const r of runs) r._routine = names[r.cronJobId] || '';
  return allRecs(ctx).filter(r => r.status === 'applied' && ctx.now >= (Number(r.appliedAtMs) || Date.parse(r.appliedAt)) + RESULTS_AFTER_DAYS * 86400e3).map(r => ({ rec: r, res: results(ctx, r, runs) }));
}
/* ---------------- the owner's two doors: one card (lib/owner-card.js) and the daily digest (lib/owner-notice.js) ---------------- */
const NUM_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six'];
// "two colleagues reviewed it" — the crew reviews in, counted (the owner's own review is not a colleague's)
function reviewedWords(rec) {
  const n = (rec.approvals || []).filter(a => a.id !== 'owner').length;
  if (!n) return 'nobody else on the crew could review it';
  return (NUM_WORDS[n] || String(n)) + (n === 1 ? ' colleague' : ' colleagues') + ' reviewed it';
}
const afterWords = rec => ((rec.approvals || []).some(a => a.id !== 'owner') ? 'after ' + reviewedWords(rec) : 'on their own, as your settings allow');
const plainOk = t => { try { return require('./lib/owner-scope').plainScore(t, { approval: true }).ok; } catch (_) { return false; } };
/* tellOwner(ctx, {from, text, technical, key}) -> what owner-notice returned: one line for the daily digest
 * (lib/owner-notice.js; a selftest hands in a stand-in). Never an immediate owner message. */
function tellOwner(ctx, o) {
  const N = ctx.notices ? ctx.notices() : null;
  try {
    if (N) return N.send({ kind: 'fyi', from: o.from || TOOL_NAME, text: o.text, technical: o.technical || undefined, key: o.key || undefined }, { root: ctx.root });
    return gov.fyi({ from: o.from || TOOL_NAME, text: o.text, technical: o.technical || undefined, key: o.key || undefined }, { root: ctx.root });
  } catch (e) { appendLog(ctx, { event: 'owner-notice-failed', key: o.key || null, error: String(e.message).slice(0, 200), by: TOOL_NAME }); return null; }
}
/* ownerCard(ctx, rec, stage) -> {filed, id?, route?, reason?} — ONE card asking the owner about this change (ref
 * harness-review:<id>; a second call updates the open card instead of adding one). stage 'review': the owner is a reviewer;
 * 'apply': the reviewed change waits for the owner because its category is at approve. Plain words up front; the diff, the
 * file and the reasons in the crew's words only under technical. owner-card may send it back (route crew, digest or ruling:
 * governance or a standing owner ruling already covers it). Never throws: a failure is logged and the change waits. */
function ownerCard(ctx, rec, stage) {
  const C = ctx.cards();
  rec.ownerRef = rec.ownerRef || 'harness-review:' + rec.id;
  if (!C) { appendLog(ctx, { event: 'owner-card-missing', id: rec.id, by: TOOL_NAME }); return { filed: false, route: 'missing', reason: 'lib/owner-card.js is not installed' }; }
  let payload = ''; try { payload = rec.change && rec.change.payload ? fs.readFileSync(ctx.P(rec.change.payload), 'utf8') : ''; } catch (_) {}
  const upstream = !!(rec.target && rec.target.file && ['tool', 'house-rule', 'policy'].includes(rec.kind) && isFrameworkFile(ctx, rec.target.file));
  const first = rec.by + ' wants to change ' + plainArea(rec) + ', and ' + reviewedWords(rec) + '.';
  // the proposer's own plain sentence (--plain) when it reads plainly; the owner always hears what they keep (a backup)
  const fallback = upstream ? 'It would go to the makers of the company software, which keeps this company as it is.' : 'It keeps a backup, so it can be undone.';
  const mine = rec.plain ? String(rec.plain).trim().replace(/[.!]?$/, '') : null;
  const short = rec.by + ' wants to change ' + plainArea(rec) + '.';   // a long name or area can push the first sentence over the limit
  const lead = [mine ? first + ' ' + mine + '.' : null, mine ? first + ' ' + mine + ', and it keeps a backup.' : null, first + ' ' + fallback, short + ' ' + fallback].filter(Boolean).find(plainOk) || short + ' ' + fallback;
  const consequence = upstream ? 'If you say yes, the crew sends it to the makers, which lets them fix it for every company. If you say no, nothing is sent.'
    : 'If you say yes, the crew makes the change and keeps a backup to undo it. If you say no, nothing changes.';
  const recommendation = 'The crew recommends yes, because it keeps their work running smoothly. If you do not answer, nothing changes.';
  const technical = [rec.id + ' (' + rec.kind + ': ' + targetLabel(rec) + ') proposed by ' + rec.by + '; reviewers ' + rec.reviewers.map(r => r.name).join(', ') + '; approved by ' + ((rec.approvals || []).map(a => a.name).join(', ') || 'nobody yet'),
    stage === 'apply' ? 'Asked because self-governance has ' + governanceCategory(rec) + ' at approve.' : rec.fixedGate ? 'Asked because it edits, in this company, code that keeps a fixed owner gate (' + rec.fixedGate + ').' : 'Asked because fewer than two crew seats could review it.',
    'Why: ' + rec.why, rec.expect ? 'Expected effect: ' + rec.expect : null, summaryLine(rec), 'Record: company/work/changes/' + rec.id + '.json',
    upstream ? 'A framework file: yes writes a framework request with the diff instead of editing it here.' : null,
    payload ? '```diff\n' + payload.slice(0, 12000) + (payload.length > 12000 ? '\n… (' + payload.length + ' bytes; the record has all of it)' : '') + '\n```' : null].filter(Boolean).join('\n\n');
  let r;
  try {
    r = C.file({ asker: rec.byId || rec.by, category: governanceCategory(rec), fixedGate: rec.fixedGate || undefined, ref: rec.ownerRef, lead, consequence, recommendation, technical,
      effect: { harnessApply: { id: rec.id } } }, { root: ctx.root });
  } catch (e) {
    appendLog(ctx, { event: 'owner-card-failed', id: rec.id, code: e.code || null, error: String(e.message).slice(0, 300), by: TOOL_NAME });
    return { filed: false, route: 'failed', reason: e.message };
  }
  r = r || { filed: false, route: 'failed' };
  rec.ownerCard = { stage, at: local(ctx.now), filed: !!r.filed, id: r.id || null, route: r.route || null };
  appendLog(ctx, { event: r.filed ? 'owner-card' : 'owner-card-not-filed', id: rec.id, stage, card: r.id || null, route: r.route || null, reason: r.reason || undefined, by: TOOL_NAME });
  return r;
}
// a not-filed card that means "the crew may decide" (governance or a standing ruling covers it): crew, digest, ruling
const coveredByCrew = r => !!r && !r.filed && ['crew', 'digest', 'ruling'].includes(r.route);
// the owner's own card for this change is answered yes (a verified owner answer; never a crew claim)
const ownerSaidYesTo = (ctx, rec) => (rec.approvals || []).some(a => a.id === 'owner') || (!!rec.ownerRef && gov.approved(rec.ownerRef, { root: ctx.root }) === true);
function withdrawCard(ctx, rec, by, why) {
  if (!rec.ownerRef) return null;
  const C = ctx.cards(); if (!C || typeof C.withdraw !== 'function') return null;
  try { return C.withdraw({ ref: rec.ownerRef, by: rec.byId || by, why }, { root: ctx.root }); }
  catch (e) { appendLog(ctx, { event: 'owner-card-withdraw-failed', id: rec.id, error: String(e.message).slice(0, 200), by: TOOL_NAME }); return null; }
}
/* ownerDecisions(ctx, opts) -> how many answers were acted on. Reads the owner's answers to this tool's cards: yes records
 * the owner's review (a change the owner reviews) or the owner's go-ahead (a reviewed change waiting at approve) and
 * applies it at once (harness-change applies, never the owner); no rejects it. Each answer is acted on once. opts.only =
 * one change id (ownerApply, the console's harnessApply effect). */
async function ownerDecisions(ctx, opts) {
  opts = opts || {};
  const log = opts.log || (() => {}); let n = 0;
  for (const rec of allRecs(ctx).filter(r => r.ownerRef && ['proposed', 'approved'].includes(r.status) && !r.ownerApplyFailedAt && (!opts.only || r.id === opts.only))) {
    const v = gov.approved(rec.ownerRef, { root: ctx.root });
    if (v === null) continue;
    if (opts.dry) { log('WOULD ' + (v ? 'APPLY' : 'REJECT') + ' ' + rec.id + ' (the owner answered on Today)'); continue; }
    const q = gov.questionFor(rec.ownerRef, { root: ctx.root });
    const ownerReviews = rec.status === 'proposed' && rec.reviewers.some(r => r.id === 'owner');
    if (v === false) {
      if (rec.status === 'proposed') review(ctx, rec.id, { viaConsole: true, note: 'declined by the owner on Today (' + (q && q.id) + ')' }, 'reject');
      else withLock(ctx, () => { const r = loadRec(ctx, rec.id); r.status = 'rejected'; hist(ctx, r, 'rejected', 'owner', 'declined on Today (' + (q && q.id) + ')'); saveRec(ctx, r); appendLog(ctx, { event: 'rejected', id: r.id, by: 'owner', via: 'owner card', status: 'rejected' }); renderSummary(ctx); });
      log('HARNESS CHANGE ' + rec.id + ' declined by the owner'); n++; continue;
    }
    if (ownerReviews) review(ctx, rec.id, { viaConsole: true, note: 'approved by the owner on Today (' + (q && q.id) + ')' }, 'approve');
    if (loadRec(ctx, rec.id).status !== 'approved') { n++; continue; }   // other reviews still to come
    try { const r = await applyChange(ctx, rec.id, { viaConsole: true }); log('HARNESS CHANGE ' + rec.id + (r.upstream ? ' sent to the framework (' + r.upstream + ')' : ' applied') + ' after the owner\'s yes'); }
    catch (e) {
      log('HARNESS CHANGE ' + rec.id + ' approved by the owner but not applied: ' + e.message);
      // tried once: the tools seat gets one handoff, not one per tick (a fresh proposal is the way forward)
      try { withLock(ctx, () => { const r = loadRec(ctx, rec.id); r.ownerApplyFailedAt = local(ctx.now); r.ownerApplyError = flat(e.message).slice(0, 300); saveRec(ctx, r); }); } catch (_) {}
      try { handoff(ctx, ctx.crew.tools, 'apply ' + rec.id + ' failed after the owner approved it', { Need: 'see why and propose it again: ' + flat(e.message).slice(0, 300), Why: rec.why, Deadline: local(ctx.now + 86400e3).slice(0, 10), Status: 'OPEN', Evidence: '`company/work/changes/' + rec.id + '.json`' }); } catch (_) {}
    }
    n++;
  }
  return n;
}
/* rerouteOwnerOnly(ctx, opts) -> how many open changes were handed back to the crew. A locked-tool change proposed while
 * the owner alone reviewed locked tools still waits on an owner card; when two crew seats can review it now and it does
 * not edit the code of a fixed owner gate here, its card is withdrawn and the risk and tools seats review it instead. */
function rerouteOwnerOnly(ctx, opts) {
  const log = (opts && opts.log) || (() => {}); let n = 0;
  for (const r0 of allRecs(ctx)) {
    if (r0.status !== 'proposed' || r0.kind !== 'tool' || !(r0.target && r0.target.locked) || r0.rerouted || !(r0.reviewers || []).length || !r0.reviewers.every(x => x.id === 'owner')) continue;
    if (r0.ownerRef && gov.approved(r0.ownerRef, { root: ctx.root }) !== null) continue;   // the owner already answered: ownerDecisions acts on it
    const proposer = person(ctx, r0.by); if (!proposer) continue;
    const crew = seats(ctx, [ctx.crew.risk, ctx.crew.tools], proposer, [ctx.crew.ceo, ctx.crew.ceo]).filter(x => x.id !== 'owner');
    if (crew.length < 2 || (OWNER_GATE_TOOLS[r0.target.file] && !isFrameworkFile(ctx, r0.target.file))) continue;
    if (opts && opts.dry) { log('WOULD REROUTE ' + r0.id + ' to ' + crew.map(x => x.name).join(' and ')); continue; }
    withLock(ctx, () => {
      const rec = loadRec(ctx, r0.id);
      withdrawCard(ctx, rec, rec.byId, 'two colleagues review this change now; the owner is asked only if the governance level needs them');
      rec.reviewers = crew; rec.rerouted = local(ctx.now); hist(ctx, rec, 'rerouted', TOOL_NAME, 'reviewed by ' + crew.map(x => x.name).join(' and ') + ' instead of the owner');
      saveRec(ctx, rec);
      appendLog(ctx, { event: 'rerouted', id: rec.id, reviewers: crew.map(x => x.name), by: TOOL_NAME });
      for (const p of crew) handoff(ctx, p, 'review ' + rec.id + ' (' + rec.kind + ': ' + targetLabel(rec) + ') proposed by ' + rec.by, {
        Need: 'review this change and decide: ' + cmdFor('approve', rec, p, ' --note "…"') + ' or ' + cmdFor('reject', rec, p, ' --note "why not"') + '. See it with `node company/tools/harness-change.js show ' + rec.id + '`.',
        Why: rec.why, Deadline: local(ctx.now + 2 * 86400e3).slice(0, 10), Status: 'OPEN', Evidence: summaryLine(rec) + ' — `company/work/changes/' + rec.id + '.json`' });
    });
    log('HARNESS CHANGE ' + r0.id + ' handed back to ' + crew.map(x => x.name).join(' and ') + ' for review (no longer the owner\'s)'); n++;
  }
  if (n) renderSummary(ctx);
  return n;
}
/* ownerApply(id, opts) -> {applied|upstream|already|waiting} — the console's {harnessApply:{id}} card effect, run on the
 * owner's answer. It acts only on a verified owner yes to this change's own card (lib/governance.js approved), so calling
 * it never stands in for the owner; it is idempotent with the dispatcher's tick. */
async function ownerApply(id, opts) {
  const ctx = context(opts || {});
  const rec = loadRec(ctx, id);
  if (!['proposed', 'approved'].includes(rec.status)) return { id, already: true, status: rec.status };
  if (!rec.ownerRef || gov.approved(rec.ownerRef, { root: ctx.root }) !== true) return { id, waiting: true, status: rec.status, note: 'no owner yes to ' + (rec.ownerRef || 'a card for this change') + ' yet' };
  await ownerDecisions(ctx, { only: id, log: (opts && opts.log) || (() => {}) });
  const after = loadRec(ctx, id);
  return { id, status: after.status, applied: after.status === 'applied', upstream: after.status === 'upstream' };
}
// the dispatcher's hook: open one results-check handoff per change that is due (once), and keep CHANGES.md current
async function tick(opts) {
  opts = opts || {}; const log = opts.log || console.log;
  const ctx = context(opts);
  if (!fs.existsSync(ctx.paths.dir)) return { due: 0, opened: 0 };
  const rerouted = rerouteOwnerOnly(ctx, opts);
  const decided = await ownerDecisions(ctx, opts);
  const due = dueList(ctx); let opened = 0;
  for (const { rec, res } of due) {
    if (rec.resultsCheckOpenedAt) continue;
    const who = rec.applier ? person(ctx, rec.applier.name) : person(ctx, rec.reviewers[0].name);
    const fields = { Need: 'decide whether ' + rec.id + ' stays: ' + cmdFor('keep', rec, who, ' --note "…"') + ', or ' + cmdFor('revert', rec, who, ' --why "…"') + ' if the results got worse. Numbers: `node company/tools/harness-change.js review-due`.',
      Why: 'applied ' + String(rec.appliedAt).slice(0, 16).replace('T', ' ') + ' by ' + rec.appliedBy + ': ' + rec.why, Deadline: local(ctx.now + 2 * 86400e3).slice(0, 10), Status: 'OPEN',
      Evidence: res.scope + ' — before: ' + fmtStat(res.before) + '; after: ' + fmtStat(res.after) + '; looks ' + res.verdict + (res.notes.length ? ' (' + res.notes.join('; ') + ')' : '') + (res.confounded ? '; ' + res.confounded : '') };
    if (opts.dry) { log('WOULD OPEN results check ' + rec.id + ' for ' + (who ? who.name : '?') + ' (' + res.verdict + ')'); continue; }
    withLock(ctx, () => {
      const r = loadRec(ctx, rec.id); if (r.resultsCheckOpenedAt) return;
      handoff(ctx, who, 'results check ' + rec.id + ' (' + rec.kind + ': ' + targetLabel(rec) + '): looks ' + res.verdict, fields);
      r.resultsCheckOpenedAt = local(ctx.now); hist(ctx, r, 'results check opened', TOOL_NAME, res.verdict); saveRec(ctx, r);
      appendLog(ctx, { event: 'results-check', id: rec.id, verdict: res.verdict, by: TOOL_NAME });
    });
    opened++; log('HARNESS CHANGE results check ' + rec.id + ' opened for ' + (who ? who.name : '?') + ': looks ' + res.verdict);
  }
  return { due: due.length, opened, decided, rerouted };
}

module.exports = { tick, ownerDecisions, ownerApply, rerouteOwnerOnly, ownerCard, ownerQuestion: (ctx, rec) => ownerCard(ctx, rec, 'review'), plainArea, OWNER_GATE_TOOLS, propose, review, applyChange, revertChange, keepChange, withdraw, dueList, context, editRules, KINDS, POLICY_FILES,
  // for locked-watch.js: the files a recorded change made, and the approved changes still waiting for their apply record.
  // opts.trust(recRelPath, recFileSha) decides whether a change record may be believed: the watcher passes one that is true
  // only for a record it already accepted or one carrying a trusted harness-change.js write row, so a hand-forged hc-*.json
  // cannot get its own target accepted. With no trust function (other callers, selftests) every record counts.
  recordedShas(opts) {
    opts = opts || {}; const ctx = context(opts); const out = {}; const trust = typeof opts.trust === 'function' ? opts.trust : null;
    for (const r of allRecs(ctx)) {
      if (!r.target || !r.target.file) continue;
      if (trust) { const rel = relOf(ctx, recFile(ctx, r.id)); if (!trust(rel, fileSha(recFile(ctx, r.id)))) continue; }
      const f = r.target.file; (out[f] = out[f] || { applied: [], pending: [] });
      if (r.applied && r.applied.sha256) out[f].applied.push(r.applied.sha256);
      if (r.reverted && r.reverted.sha256) out[f].applied.push(r.reverted.sha256);
      if (r.status === 'approved') out[f].pending.push({ id: r.id, approvedAt: r.approvedAt });
    }
    return out;
  },
  // for locked-watch.js schedule watch: applied/reverted schedule changes per routine, newest effective expr+tz and when
  appliedSchedules(opts) {
    const ctx = context(opts || {}); const out = {};
    for (const r of allRecs(ctx)) {
      if (r.kind !== 'schedule' || !r.target || !r.target.jobId) continue;
      if (r.status === 'applied' || r.status === 'kept') { const s = (r.applied && r.applied.schedule) || r.change.schedule; (out[r.target.jobId] = out[r.target.jobId] || []).push({ expr: s.expr, tz: s.tz || null, at: r.appliedAtMs || Date.parse(r.appliedAt) }); }
      else if (r.status === 'reverted') { const s = (r.reverted && r.reverted.schedule) || r.before.schedule; (out[r.target.jobId] = out[r.target.jobId] || []).push({ expr: s.expr, tz: s.tz || null, at: Date.parse(r.revertedAt) }); }
    }
    return out;
  } };

/* ---------------- selftest ---------------- */
async function selftest() {
  const assert = require('assert'); const os = require('os');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-change-selftest-'));
  const prevProv = process.env.PROVENANCE_ROOT; process.env.PROVENANCE_ROOT = T;
  const out = []; let bad = 0;
  const skip = name => out.push('skip ' + name);
  const t = async (name, fn) => { try { await fn(); out.push('ok   ' + name); } catch (e) { bad++; out.push('FAIL ' + name + ': ' + (e && e.message)); } };
  const W = (rel, v) => { fs.mkdirSync(path.dirname(path.join(T, rel)), { recursive: true }); fs.writeFileSync(path.join(T, rel), typeof v === 'string' ? v : JSON.stringify(v, null, 1) + '\n'); };
  const R = rel => fs.readFileSync(path.join(T, rel), 'utf8');
  W('company/tools/loops.json', { agents: {
    agent: { name: 'Alex', manager: null, functions: ['ceo'], inbox: 'to-alex.md' }, drafter: { name: 'Sam', manager: 'agent', inbox: 'to-sam.md' },
    designer: { name: 'Jo', manager: 'drafter', inbox: 'to-jo.md' }, hiring: { name: 'Kim', manager: 'agent', functions: ['people'], inbox: 'to-kim.md' },
    engineer: { name: 'Max', manager: 'agent', functions: ['tools'], inbox: 'to-max.md' }, auditor: { name: 'Riley', manager: 'agent', functions: ['risk'], inbox: 'to-riley.md' },
    treasurer: { name: 'Pat', manager: 'agent', functions: ['finance'], inbox: 'to-pat.md' } } });
  fs.mkdirSync(path.join(T, 'company/work/handoffs'), { recursive: true });
  // self-governance for this scratch company: everything auto, so the review cases below test review alone (the
  // governance cases at the end set levels one by one)
  const govDoc = JSON.parse(fs.readFileSync(path.join(LIVE_ROOT, 'company/defaults/state/governance.json'), 'utf8'));
  for (const k of Object.keys(govDoc.categories)) govDoc.categories[k] = 'auto';
  const setGov = (cat, lv) => { govDoc.categories[cat] = lv; W('company/state/governance.json', govDoc); };
  W('company/state/governance.json', govDoc);
  W('company/tools/sample.js', "'use strict';\nconst N = 1;\nif (process.argv[2] === 'selftest') { if (N + 1 !== 2) { console.log('FAIL math'); process.exit(1); } console.log('all checks passed'); }\nmodule.exports = { N };\n");
  fs.copyFileSync(path.join(__dirname, 'routine-rules.js'), path.join(T, 'company/tools/routine-rules.js'));
  // routine-rules.js requires ./lib/company, and the apply path runs the edited copy from T/company/tools, so the scratch
  // company needs lib/ beside it (without it the house-rule case fails wherever StarNet is installed and the case runs)
  fs.cpSync(path.join(__dirname, 'lib'), path.join(T, 'company/tools/lib'), { recursive: true });
  W('company/work/finance/pacing-policy.json', { _doc: 'x', marginPct: 5, subs: { claude: { dailyFraction: 0.142857 } } });
  W('company/model-policy.json', { routing: { models: { haiku: { provider: 'claude-cli', model: 'haiku' }, sonnet: { provider: 'claude-cli', model: 's' }, deepseek: { provider: 'deepseek', model: 'd' } }, routines: { 'Design loop': { claude: null, minimax: true } } }, performance: { consecutiveFailures: 3 } });
  const job = { id: 'job-design', name: 'Design loop', agentId: 'designer', schedule: { kind: 'cron', expr: '45 11 * * *', tz: 'Europe/Lisbon' } };
  const posts = [];
  const call = async (m, p, body) => { if (m === 'GET') return { status: 200, body: JSON.stringify({ jobs: [job] }) }; posts.push(body); job.schedule = { kind: 'cron', expr: body.patch.schedule, tz: body.patch.timezone || job.schedule.tz }; return { status: 200, body: JSON.stringify({ ok: true, job }) }; };
  let now = Date.parse('2026-11-15T10:00:00Z');
  // the owner's two doors, as stand-ins with the shared contract (tests/helpers/owner-stubs.js): a card is filed only when
  // the contract says so, and every lead, consequence and recommendation must pass the plain-words check
  const stubs = require('./tests/helpers/owner-stubs.js');
  const notice = stubs.makeOwnerNotice(); const card = stubs.makeOwnerCard(T, { notice });
  const C = (x) => context(Object.assign({ root: T, call, now, underStation: true, ownerCard: card, ownerNotice: notice }, x || {}));
  const asksFor = ref => { try { return R('company/pm-inbox.jsonl').trim().split('\n').filter(Boolean).map(JSON.parse).filter(x => x.type === 'ask' && x.gate && x.gate.ref === ref); } catch (_) { return []; } };
  const ownerAnswer = (qid, yes) => require('./lib/pm-inbox-guard').append(path.join(T, 'company/pm-inbox.jsonl'), { type: 'answer', id: qid, a: yes ? 'yes' : 'no', answer: { verdict: yes ? 'yes' : 'no', action: yes ? 'approve' : 'decline', values: {} }, by: 'Commander' }, 'selftest');
  const plainCheck = c => ['lead', 'consequence', 'recommendation'].every(k => require('./lib/owner-scope').plainScore(c[k], { approval: true }).ok);
  const inbox = n => { try { return R('company/work/handoffs/to-' + n + '.md'); } catch (_) { return ''; } };
  const openIn = (n, needle) => inbox(n).split(/^(?=## )/m).filter(s => s.includes(needle) && /^\*\*Status:\*\*\s*OPEN/m.test(s)).length;
  let sch;
  await t('schedule: Jo proposes, Sam (his manager) reviews; nobody reviews their own; an OPEN handoff reaches the reviewer', async () => {
    sch = await propose(C(), { kind: 'schedule', target: 'Design loop', why: 'design reviews land before the noon standup', change: '0 9 * * *', by: 'Jo' });
    assert.deepStrictEqual(sch.reviewers.map(r => r.name), ['Sam']); assert.strictEqual(openIn('sam', 'review ' + sch.id), 1);
    assert.throws(() => review(C(), sch.id, { by: 'Jo' }, 'approve'), /own proposal/);
    assert.throws(() => review(C(), sch.id, { by: 'Max' }, 'approve'), /not a reviewer/);
    await assert.rejects(propose(C(), { kind: 'schedule', target: 'Design loop', why: 'short', change: '0 9 * * *', by: 'Jo' }), /at least 20/);
    await assert.rejects(propose(C(), { kind: 'schedule', target: 'Design loop', why: 'Max wants Jo earlier in the day', change: '0 8 * * *', by: 'Max' }), /may propose/);
  });
  await t('schedule: approve opens an apply handoff; apply posts /api/cron/update with a backup of the old value; revert puts it back', async () => {
    review(C(), sch.id, { by: 'Sam', note: 'fine' }, 'approve');
    assert.strictEqual(openIn('sam', 'review ' + sch.id), 0); assert.strictEqual(openIn('sam', 'apply ' + sch.id), 1);
    await assert.rejects(applyChange(C(), sch.id, { by: 'Jo' }), /reviewer applies/);
    const r = await applyChange(C(), sch.id, { by: 'Sam' });
    assert.strictEqual(r.status, 'applied'); assert.deepStrictEqual(posts[0], { id: 'job-design', patch: { schedule: '0 9 * * *', timezone: 'Europe/Lisbon' } });
    assert.strictEqual(openIn('sam', 'apply ' + sch.id), 0); assert.ok(inbox('jo').includes(sch.id + ' applied'));
    const rv = await revertChange(C(), sch.id, { by: 'Sam', why: 'standup moved' });
    assert.strictEqual(rv.status, 'reverted'); assert.strictEqual(job.schedule.expr, '45 11 * * *');
  });
  const haveCron = !!cronLib({ root: T }), haveGuard = (() => { for (const f of [path.join(LIVE_ROOT, 'starnet/sidecar/cron-guard.js')]) { try { require(f); return true; } catch (_) {} } return false; })();
  if (!haveCron) skip('a schedule change that adds runs a day sends the finance holder an FYI (starnet/sidecar/cron.js not installed)');
  else await t('a schedule change that adds runs a day sends Pat an FYI', async () => {
    const r = await propose(C(), { kind: 'schedule', target: 'Design loop', why: 'more design passes while the launch is on', change: '45 */4 * * *', by: 'Jo' });
    review(C(), r.id, { by: 'Sam' }, 'approve'); await applyChange(C(), r.id, { by: 'Sam' });
    assert.ok(/now runs more often \(1 -> 6 a day\)/.test(inbox('pat')), inbox('pat').slice(-300));
    await revertChange(C(), r.id, { by: 'Sam' });
  });
  let tool;
  await t('tool: a diff is checked at proposal, applied with its selftest and a backup, and reverted only while unchanged', async () => {
    const diff = "--- a/sample.js\n+++ b/sample.js\n@@ -1,3 +1,3 @@\n 'use strict';\n-const N = 1;\n+const N = 1; // one\n if (process.argv[2] === 'selftest') { if (N + 1 !== 2) { console.log('FAIL math'); process.exit(1); } console.log('all checks passed'); }\n";
    W('scratch/x.diff', diff);
    tool = await propose(C(), { kind: 'tool', target: 'company/tools/sample.js', why: 'document the constant for the next reader', change: 'scratch/x.diff', by: 'Jo' });
    assert.deepStrictEqual(tool.reviewers.map(r => r.name), ['Max']);
    const mine = await propose(C(), { kind: 'tool', target: 'company/tools/sample.js', why: 'Max documents her own constant here', change: 'scratch/x.diff', by: 'Max' });
    assert.deepStrictEqual(mine.reviewers.map(r => r.name), ['Riley']); withdraw(C(), mine.id, { by: 'Max' });
    review(C(), tool.id, { by: 'Max' }, 'approve');
    const r = await applyChange(C(), tool.id, { by: 'Max' });
    assert.ok(R('company/tools/sample.js').includes('// one')); assert.ok(fs.existsSync(path.join(T, r.applied.backup)));
    W('company/tools/sample.js', R('company/tools/sample.js') + '// later edit\n');
    await assert.rejects(revertChange(C(), tool.id, { by: 'Max' }), /changed since/);
  });
  await t('tool: a broken change is refused at proposal; a failing selftest stops the apply and leaves the file', async () => {
    await assert.rejects(propose(C(), { kind: 'tool', target: 'company/tools/sample.js', why: 'this breaks the syntax on purpose', change: 'const = ;', by: 'Jo' }), /syntax check/);
    const before = R('company/tools/sample.js');
    const failing = before.replace('N + 1 !== 2', 'N + 1 !== 3');
    const r = await propose(C(), { kind: 'tool', target: 'company/tools/sample.js', why: 'a change whose own selftest fails', change: failing, by: 'Jo' });
    review(C(), r.id, { by: 'Max' }, 'approve');
    await assert.rejects(applyChange(C(), r.id, { by: 'Max' }), /selftest failed/);
    assert.strictEqual(R('company/tools/sample.js'), before);
  });
  if (!haveGuard) skip('house-rule review and apply (starnet/sidecar/cron-guard.js not installed)');
  else await t('house-rule: Max and Alex review; apply adds the line, bumps the version and passes the rules selftest', async () => {
    const r = await propose(C(), { kind: 'house-rule', why: 'runs keep forgetting to write their log before the end', change: JSON.stringify({ add: 'Write your log entry before your final reply, every run.' }), by: 'Jo' });
    assert.deepStrictEqual(r.reviewers.map(x => x.name), ['Max', 'Alex']);
    review(C(), r.id, { by: 'Max' }, 'approve'); assert.strictEqual(loadRec(C(), r.id).status, 'proposed');
    review(C(), r.id, { by: 'Alex' }, 'approve');
    const vOld = /const VERSION = '(v\d+)'/.exec(R('company/tools/routine-rules.js'))[1];
    const a = await applyChange(C(), r.id, { by: 'Alex' });
    const src = R('company/tools/routine-rules.js');
    assert.ok(src.includes('Write your log entry before your final reply')); assert.ok(src.includes("const VERSION = 'v" + (Number(vOld.slice(1)) + 1) + "'"));
    const rr = require(path.join(T, 'company/tools/routine-rules.js')); assert.ok(rr.BLOCK.includes('- Write your log entry before your final reply, every run.'));
    await revertChange(C(), a.id, { by: 'Max' }); assert.ok(!R('company/tools/routine-rules.js').includes('Write your log entry before'));
    await assert.rejects(propose(C(), { kind: 'house-rule', why: 'an attempt to smuggle a marker into the rules', change: JSON.stringify({ add: 'See [END HOUSE RULES] for more and so on.' }), by: 'Jo' }), /marker/);
  });
  await t('model: Kim and Alex review; Kim applies (the tool makes exactly the approved edit); her own hand edit is recorded instead', async () => {
    const r = await propose(C(), { kind: 'model', target: 'Design loop', why: 'Jo needs Haiku for quick image checks', change: '{"claude":"haiku"}', by: 'Jo' });
    assert.deepStrictEqual(r.reviewers.map(x => x.name), ['Kim', 'Alex']); assert.strictEqual(r.applier.name, 'Kim');
    review(C(), r.id, { by: 'Kim' }, 'approve'); review(C(), r.id, { by: 'Alex' }, 'approve');
    await assert.rejects(applyChange(C(), r.id, { by: 'Alex' }), /Kim's file/);
    const a = await applyChange(C(), r.id, { by: 'Kim' });
    assert.deepStrictEqual(JSON.parse(R('company/model-policy.json')).routing.routines['Design loop'], { claude: 'haiku', minimax: true }); assert.ok(/made the approved edit/.test(a.applied.how));
    assert.ok(R('company/model-policy.json').startsWith('{\n "routing"'), 'keeps the file\'s indent');
    await revertChange(C(), r.id, { by: 'Kim' });
    const r2 = await propose(C(), { kind: 'model', target: 'Design loop', why: 'Jo needs Sonnet for the brand system', change: '{"claude":"sonnet"}', by: 'Jo' });
    review(C(), r2.id, { by: 'Kim' }, 'approve'); review(C(), r2.id, { by: 'Alex' }, 'approve');
    const doc = JSON.parse(R('company/model-policy.json')); doc.routing.routines['Design loop'].claude = 'sonnet'; W('company/model-policy.json', doc);
    const a2 = await applyChange(C(), r2.id, { by: 'Kim' }); assert.ok(/recorded Kim's own edit/.test(a2.applied.how));
    await assert.rejects(propose(C(), { kind: 'model', target: 'Design loop', why: 'an Opus routine is not allowed here', change: '{"claude":"opus"}', by: 'Jo' }), /claude must be/);
  });
  await t('policy: Pat reviews pacing numbers, Alex when she proposes; types and notes are checked; Pat applies', async () => {
    const r = await propose(C(), { kind: 'policy', target: 'pacing-policy.json', why: 'the margin is too tight on Mondays', change: '{"/marginPct": 3}', by: 'Jo' });
    assert.deepStrictEqual(r.reviewers.map(x => x.name), ['Pat']);
    const s = await propose(C(), { kind: 'policy', target: 'pacing-policy.json', why: 'Pat loosens her own margin a little', change: '{"/marginPct": 4}', by: 'Pat' });
    assert.deepStrictEqual(s.reviewers.map(x => x.name), ['Alex']); assert.strictEqual(s.applier.name, 'Pat'); withdraw(C(), s.id, { by: 'Pat' });
    await assert.rejects(propose(C(), { kind: 'policy', target: 'pacing-policy.json', why: 'a string where a number belongs', change: '{"/marginPct": "3"}', by: 'Jo' }), /is a number/);
    await assert.rejects(propose(C(), { kind: 'policy', target: 'model-policy.json', why: 'routing is not a policy number at all', change: '{"/routing/routines/Design loop/claude": "haiku"}', by: 'Jo' }), /only \/performance/);
    review(C(), r.id, { by: 'Pat' }, 'approve'); const a = await applyChange(C(), r.id, { by: 'Pat' });
    assert.strictEqual(JSON.parse(R('company/work/finance/pacing-policy.json')).marginPct, 3); assert.strictEqual(a.status, 'applied');
  });
  await t('schedule on cadence.json: finance, risk and people review (never the proposer); applied as whole sections; reverted', async () => {
    W('company/work/ops/cadence.json', { dispatcherTickMin: 10, defaultCooldownMin: 40, maxPerTick: 4, bounds: { tickMin: [5, 30], cooldownMin: [10, 120], maxWakesPerHour: 12, maxWakesPerDay: 120, quietHours: null }, tempo: { mode: 'bounded-auto', autoExpireMin: 30, minChangeIntervalMin: 15 }, seats: {} });
    const r = await propose(C(), { kind: 'schedule', target: 'cadence.json', why: 'launch week: let the crew tick every 3 minutes', change: '{"/bounds/tickMin":[3,30]}', by: 'Alex' });
    assert.deepStrictEqual(r.reviewers.map(x => x.name), ['Pat', 'Riley', 'Kim']); assert.strictEqual(r.applier, null);
    const own = await propose(C(), { kind: 'schedule', target: 'cadence.json', why: 'Pat widens the tick range for herself', change: '{"/dispatcherTickMin":3}', by: 'Pat' });
    assert.deepStrictEqual(own.reviewers.map(x => x.name), ['Alex', 'Riley', 'Kim']); withdraw(C(), own.id, { by: 'Pat' });
    await assert.rejects(propose(C(), { kind: 'schedule', target: 'cadence.json', why: 'rewrite the change log while at it', change: '{"/changes":[]}', by: 'Alex' }), /not a tempo number/);
    review(C(), r.id, { by: 'Pat' }, 'approve'); review(C(), r.id, { by: 'Riley' }, 'approve');
    assert.strictEqual(loadRec(C(), r.id).status, 'proposed');
    review(C(), r.id, { by: 'Kim' }, 'approve');
    const a = await applyChange(C(), r.id, { by: 'Riley' });
    const doc = JSON.parse(R('company/work/ops/cadence.json'));
    assert.deepStrictEqual(doc.bounds.tickMin, [3, 30]); assert.strictEqual(doc.bounds.maxWakesPerHour, 12); assert.strictEqual(a.status, 'applied');
    await revertChange(C(), r.id, { by: 'Kim' });
    assert.deepStrictEqual(JSON.parse(R('company/work/ops/cadence.json')).bounds.tickMin, [5, 30]);
  });
  await t('an apply refuses to record edits that ride in beyond the approved change', async () => {
    const r = await propose(C(), { kind: 'policy', target: 'pacing-policy.json', why: 'raise the margin a touch for the weekend rush', change: '{"/marginPct": 6}', by: 'Jo' });
    review(C(), r.id, { by: 'Pat' }, 'approve');
    const doc = JSON.parse(R('company/work/finance/pacing-policy.json')); doc.marginPct = 6; doc.subs.claude.dailyFraction = 0.9; W('company/work/finance/pacing-policy.json', doc);   // a second number sneaked in
    await assert.rejects(applyChange(C(), r.id, { by: 'Pat' }), /beyond the approved change/);
    const d2 = JSON.parse(R('company/work/finance/pacing-policy.json')); d2.subs.claude.dailyFraction = 0.142857; W('company/work/finance/pacing-policy.json', d2);
    const a = await applyChange(C(), r.id, { by: 'Pat' }); assert.ok(/own edit/.test(a.applied.how)); assert.strictEqual(JSON.parse(R('company/work/finance/pacing-policy.json')).subs.claude.dailyFraction, 0.142857);
  });
  await t('reverting a change that ADDED a key removes it, not leaves it behind', async () => {
    const r = await propose(C(), { kind: 'policy', target: 'pacing-policy.json', why: 'add a brand-new weekend margin knob to try out', change: '{"/weekendMarginPct": 8}', by: 'Jo' });
    review(C(), r.id, { by: 'Pat' }, 'approve'); await applyChange(C(), r.id, { by: 'Pat' });
    assert.strictEqual(JSON.parse(R('company/work/finance/pacing-policy.json')).weekendMarginPct, 8);
    await revertChange(C(), r.id, { by: 'Pat' });
    assert.ok(!('weekendMarginPct' in JSON.parse(R('company/work/finance/pacing-policy.json'))), 'the added key is gone after revert');
  });
  const lw = (() => { try { return require('./locked-watch.js'); } catch (_) { return null; } })();
  if (!lw) skip('locked tools (locked-watch.js not installed)');
  else await t('locked tools: the risk and tools holders review (never the proposer, the CEO stands in); at tools=auto it never reaches the owner', async () => {
    W('company/tools/pacer.js', "'use strict';\nmodule.exports = {};\n");
    const n0 = card.calls.length;
    const r = await propose(C(), { kind: 'tool', target: 'company/tools/pacer.js', why: 'a comment for the next reader of the pacer', change: "'use strict';\n// pacer\nmodule.exports = {};\n", by: 'Jo' });
    assert.deepStrictEqual(r.reviewers.map(x => x.name), ['Riley', 'Max']); assert.ok(r.target.locked); assert.ok(!r.ownerRef);
    const own = await propose(C(), { kind: 'tool', target: 'company/tools/pacer.js', why: 'Max documents the pacer for the next reader', change: "'use strict';\n// max\nmodule.exports = {};\n", by: 'Max' });
    assert.deepStrictEqual(own.reviewers.map(x => x.name), ['Riley', 'Alex']); withdraw(C(), own.id, { by: 'Max' });
    review(C(), r.id, { by: 'Riley' }, 'approve'); assert.strictEqual(loadRec(C(), r.id).status, 'proposed');
    review(C(), r.id, { by: 'Max' }, 'approve');
    const a = await applyChange(C(), r.id, { by: 'Max' });
    assert.strictEqual(a.status, 'applied'); assert.ok(R('company/tools/pacer.js').includes('// pacer'));
    assert.strictEqual(card.calls.length, n0, 'no owner card was even tried'); assert.strictEqual(asksFor('harness-review:' + r.id).length, 0);
    assert.ok(!notice.sent.some(x => String(x.key || '').includes(r.id)), 'nothing in the digest at auto');
  });
  if (lw) await t('locked tools at tools=approve: ONE plain owner card after the two reviews (the diff only under technical); yes applies it, no rejects it', async () => {
    setGov('tools', 'approve');
    const r = await propose(C(), { kind: 'tool', target: 'company/tools/pacer.js', why: 'count a report only once in the pacer totals', change: "'use strict';\n// pacer once\nmodule.exports = {};\n", by: 'Jo', plain: 'It only changes how a report is counted.' });
    assert.strictEqual(asksFor('harness-review:' + r.id).length, 0, 'no card before the crew has reviewed');
    review(C(), r.id, { by: 'Riley' }, 'approve'); review(C(), r.id, { by: 'Max' }, 'approve');
    const qs = asksFor('harness-review:' + r.id); assert.strictEqual(qs.length, 1);
    const c = card.calls.filter(x => x.op === 'file' && x.card.ref === 'harness-review:' + r.id).pop().card;
    assert.strictEqual(c.lead, 'Jo wants to change how the crew\'s spending is paced and capped, and two colleagues reviewed it. It only changes how a report is counted, and it keeps a backup.');
    assert.ok(plainCheck(c), 'lead, consequence and recommendation read plainly');
    assert.ok(!/pacer|\.js|hc-\d|@@|company\//.test(c.lead + c.consequence + c.recommendation), 'no file, id or diff up front');
    assert.ok(/pacer once/.test(c.technical) && /company\/tools\/pacer\.js/.test(c.technical), 'the diff and the file are under technical');
    assert.deepStrictEqual(c.effect, { harnessApply: { id: r.id } }); assert.strictEqual(c.category, 'tools'); assert.strictEqual(c.fixedGate, undefined);
    assert.strictEqual(openIn('max', 'apply ' + r.id), 0, 'nobody is handed an apply while the owner decides');
    await assert.rejects(applyChange(C(), r.id, { by: 'Max' }), /waits for the owner/);
    await assert.rejects(applyChange(C(), r.id, { by: 'Max' }), /waits for the owner/);
    assert.strictEqual(asksFor('harness-review:' + r.id).length, 1, 'a retry files no second card');
    assert.deepStrictEqual(await ownerApply(r.id, { root: T, now, call, underStation: true, ownerCard: card, ownerNotice: notice }).then(x => x.waiting), true, 'no yes yet: the effect does nothing');
    ownerAnswer(qs[0].id, true);
    const done = await ownerApply(r.id, { root: T, now, call, underStation: true, ownerCard: card, ownerNotice: notice });
    assert.ok(done.applied, JSON.stringify(done)); assert.ok(R('company/tools/pacer.js').includes('// pacer once'));
    assert.strictEqual(await ownerDecisions(C()), 0, 'acted on once (the tick after the console finds nothing to do)');
    const r2 = await propose(C(), { kind: 'tool', target: 'company/tools/pacer.js', why: 'drop the pacer comment again later on', change: "'use strict';\nmodule.exports = {};\n", by: 'Jo' });
    review(C(), r2.id, { by: 'Riley' }, 'approve'); review(C(), r2.id, { by: 'Max' }, 'approve');
    ownerAnswer(asksFor('harness-review:' + r2.id)[0].id, false);
    await ownerDecisions(C()); assert.strictEqual(loadRec(C(), r2.id).status, 'rejected'); assert.ok(R('company/tools/pacer.js').includes('// pacer once'));
    setGov('tools', 'auto');
  });
  if (lw) await t('the code that keeps a fixed owner gate: the crew reviews, then the owner (one card naming the gate); withdraw closes the card; records and the crew list keep their own routes', async () => {
    W('company/tools/external-gate.js', "'use strict';\nmodule.exports = {};\n");
    const r = await propose(C(), { kind: 'tool', target: 'company/tools/external-gate.js', why: 'open the external gate a crack for my sends', change: "'use strict';\n// open\nmodule.exports = {};\n", by: 'Jo' });
    assert.deepStrictEqual(r.reviewers.map(x => x.id), ['auditor', 'engineer', 'owner']); assert.strictEqual(r.fixedGate, 'commitments');
    review(C(), r.id, { by: 'Riley' }, 'approve'); assert.strictEqual(asksFor(r.ownerRef).length, 0);
    review(C(), r.id, { by: 'Max' }, 'approve');
    const q = asksFor(r.ownerRef); assert.strictEqual(q.length, 1); assert.strictEqual(q[0].gate.fixedGate, 'commitments');
    assert.strictEqual(loadRec(C(), r.id).status, 'proposed', 'still the owner\'s review to come');
    assert.ok(card.openFor(r.ownerRef));
    withdraw(C(), r.id, { by: 'Jo', why: 'not needed after all' });
    assert.strictEqual(card.openFor(r.ownerRef), null, 'the card is withdrawn with the change');
    assert.strictEqual(await ownerDecisions(C()), 0);
    await assert.rejects(propose(C(), { kind: 'tool', target: 'company/tools/loops.json', why: 'give myself a different manager quietly', change: '{"agents":{}}', by: 'Jo' }), /locked/);
    await assert.rejects(propose(C(), { kind: 'tool', target: 'company/work/people/competence-events.jsonl', why: 'tidy the competence ledger by hand', change: 'x', by: 'Jo' }), /shared file/);
  });
  if (lw) await t('an open locked-tool change from before (the owner its only reviewer) is handed back to the risk and tools seats by the tick, and its card withdrawn', async () => {
    const r = await propose(C(), { kind: 'tool', target: 'company/tools/pacer.js', why: 'an older change the owner alone was to review', change: "'use strict';\n// old route\nmodule.exports = {};\n", by: 'Jo' });
    closeHandoffs(C(), 'review ' + r.id + ' ', 'an older record had no crew review');   // as it was: the owner alone, no crew handoff
    const rec = loadRec(C(), r.id); rec.reviewers = [{ id: 'owner', name: 'owner' }]; rec.ownerRef = 'harness-review:' + r.id;
    setGov('tools', 'approve'); ownerCard(C(), rec, 'review'); setGov('tools', 'auto'); saveRec(C(), rec);
    assert.ok(card.openFor(rec.ownerRef));
    const t1 = await tick({ root: T, now, log: () => {}, call, underStation: true, ownerCard: card, ownerNotice: notice });
    assert.strictEqual(t1.rerouted, 1); const after = loadRec(C(), r.id);
    assert.deepStrictEqual(after.reviewers.map(x => x.name), ['Riley', 'Max']); assert.strictEqual(card.openFor(rec.ownerRef), null);
    assert.strictEqual(openIn('riley', 'review ' + r.id), 1);
    assert.strictEqual((await tick({ root: T, now, log: () => {}, call, underStation: true, ownerCard: card, ownerNotice: notice })).rerouted, 0, 'once');
    withdraw(C(), r.id, { by: 'Jo' });
  });
  if (lw) await t('a re-proposal: --replaces (or a "Replaces hc-NNNN" line) withdraws the old change and its card; the same change again updates the open record', async () => {
    const v1 = await propose(C(), { kind: 'tool', target: 'company/tools/external-gate.js', why: 'tidy the external gate header comment', change: "'use strict';\n// v1\nmodule.exports = {};\n", by: 'Jo' });
    review(C(), v1.id, { by: 'Riley' }, 'approve'); review(C(), v1.id, { by: 'Max' }, 'approve');
    assert.ok(card.openFor(v1.ownerRef));
    const v2 = await propose(C(), { kind: 'tool', target: 'company/tools/external-gate.js', why: 'Replaces ' + v1.id + ': tidy the header comment better', change: "'use strict';\n// v2\nmodule.exports = {};\n", by: 'Jo' });
    assert.strictEqual(loadRec(C(), v1.id).status, 'withdrawn'); assert.strictEqual(card.openFor(v1.ownerRef), null); assert.strictEqual(v2.replaces, v1.id);
    const v3 = await propose(C(), { kind: 'tool', target: 'company/tools/external-gate.js', why: 'tidy the header comment, now with the right words', change: "'use strict';\n// v3\nmodule.exports = {};\n", by: 'Jo', replaces: v2.id });
    assert.strictEqual(loadRec(C(), v2.id).status, 'withdrawn');
    await assert.rejects(propose(C(), { kind: 'tool', target: 'company/tools/external-gate.js', why: 'Max tries to withdraw what Jo proposed', change: "'use strict';\n// v4\nmodule.exports = {};\n", by: 'Max', replaces: v3.id }), /only Jo may withdraw/);
    const same = await propose(C(), { kind: 'tool', target: 'company/tools/external-gate.js', why: 'the same change again, better worded this time', change: "'use strict';\n// v3\nmodule.exports = {};\n", by: 'Jo' });
    assert.strictEqual(same.id, v3.id); assert.ok(same.again); assert.strictEqual(loadRec(C(), v3.id).why, 'the same change again, better worded this time');
    assert.strictEqual(allRecs(C()).filter(x => x.target.file === 'company/tools/external-gate.js' && x.status === 'proposed').length, 1);
    withdraw(C(), v3.id, { by: 'Jo' });
  });
  await t('review-due: after 3 days the change is due with before/after numbers; tick opens one results-check handoff, once', async () => {
    const runs = [];
    const applied = loadRec(C(), tool.id); const at = applied.appliedAtMs;
    for (let i = 0; i < 6; i++) runs.push({ runId: 'b' + i, cronJobId: 'job-design', startedAt: at - (i + 1) * 3600e3, reason: 'done', durationMs: 600000, provider: 'p', model: 'm' });
    for (let i = 0; i < 6; i++) runs.push({ runId: 'a' + i, cronJobId: 'job-design', startedAt: at + (i + 1) * 3600e3, reason: i < 3 ? 'done' : 'max_iters', durationMs: 600000, provider: 'p', model: 'm' });
    W('.starnet-data/workspaces/runs.jsonl', runs.map(r => JSON.stringify(r)).join('\n') + '\n');
    // the tool change was later edited by hand, so make it applied again for the check
    const rec = loadRec(C(), tool.id); assert.strictEqual(rec.status, 'applied');
    now += 4 * 86400e3;
    const due = dueList(C()); const d = due.find(x => x.rec.id === tool.id);
    assert.ok(d, 'due'); assert.strictEqual(d.res.before.finishRate, 100); assert.strictEqual(d.res.after.finishRate, 50); assert.strictEqual(d.res.verdict, 'worse');
    const r1 = await tick({ root: T, now, log: () => {}, call, underStation: true, ownerCard: card, ownerNotice: notice }); const r2 = await tick({ root: T, now, log: () => {}, call, underStation: true, ownerCard: card, ownerNotice: notice });
    assert.ok(r1.opened >= 1); assert.strictEqual(r2.opened, 0); assert.strictEqual(openIn('max', 'results check ' + tool.id), 1);
    keepChange(C(), tool.id, { by: 'Max', note: 'the drop is from the hand edit, not the change' }); assert.strictEqual(openIn('max', 'results check ' + tool.id), 0);
  });
  await t('one seat holding every function: nobody reviews their own; at tools=auto the crew decides (no card), at approve the owner gets one card and reviews from Today or their own shell only', async () => {
    const T2 = path.join(T, 'solo'); const W2 = (rel, v) => { fs.mkdirSync(path.dirname(path.join(T2, rel)), { recursive: true }); fs.writeFileSync(path.join(T2, rel), typeof v === 'string' ? v : JSON.stringify(v, null, 1) + '\n'); };
    W2('company/tools/loops.json', { agents: { agent: { name: 'Alex', manager: null, functions: ['ceo', 'people', 'tools', 'risk', 'floor', 'finance'], inbox: 'to-alex.md' } } });
    W2('company/tools/sample.js', R('company/tools/sample.js'));
    const gd = JSON.parse(JSON.stringify(govDoc)); gd.categories.tools = 'auto'; W2('company/state/governance.json', gd);
    const card2 = stubs.makeOwnerCard(T2, { notice });
    const C2 = x => context(Object.assign({ root: T2, call, now, underStation: true, ownerCard: card2, ownerNotice: notice }, x || {}));
    const r0 = await propose(C2(), { kind: 'tool', target: 'company/tools/sample.js', why: 'the founder documents a constant at auto', change: R('company/tools/sample.js').replace('const N = 1;', 'const N = 1; // auto'), by: 'Alex' });
    assert.strictEqual(r0.status, 'approved'); assert.deepStrictEqual(r0.reviewers, []); assert.strictEqual(r0.applier.name, 'Alex'); assert.ok(r0.ownerWaived && r0.unreviewed);
    assert.ok(!fs.existsSync(path.join(T2, 'company/pm-inbox.jsonl')) || !fs.readFileSync(path.join(T2, 'company/pm-inbox.jsonl'), 'utf8').includes('"harness-review:' + r0.id + '"'));
    assert.strictEqual((await applyChange(C2(), r0.id, { by: 'Alex' })).status, 'applied');
    gd.categories.tools = 'approve'; W2('company/state/governance.json', gd);
    const r = await propose(C2(), { kind: 'tool', target: 'company/tools/sample.js', why: 'the founder documents a constant for the next reader', change: R('company/tools/sample.js').replace('const N = 1;', 'const N = 1; // solo'), by: 'Alex' });
    assert.deepStrictEqual(r.reviewers.map(x => x.id), ['owner']);
    const c = card2.calls.filter(x => x.op === 'file').pop().card;
    assert.ok(/^Alex wants to change one of the crew's shared tools, and nobody else on the crew could review it\./.test(c.lead), c.lead); assert.ok(plainCheck(c));
    assert.ok(fs.readFileSync(path.join(T2, 'company/pm-inbox.jsonl'), 'utf8').includes('"harness-review:' + r.id + '"'));
    assert.ok(!fs.existsSync(path.join(T2, 'company/owner/outbound.jsonl')) || !fs.readFileSync(path.join(T2, 'company/owner/outbound.jsonl'), 'utf8').includes('harness-change.js approve'));
    assert.throws(() => review(C2(), r.id, { by: 'Alex' }, 'approve'), /own proposal/);
    assert.throws(() => review(C2(), r.id, { by: 'owner' }, 'approve'), /must be someone/);   // not from inside a station run
    assert.strictEqual(review(C2({ underStation: false, ownerShell: true }), r.id, { by: 'owner' }, 'approve').status, 'approved');
  });
  await t('every event is logged with its claimed author, and the summary lists every change', async () => {
    const log = R('company/work/people/harness-log.jsonl').trim().split('\n').map(JSON.parse);
    assert.ok(log.every(e => e.tool === 'harness-change')); assert.ok(log.some(e => e.event === 'applied' && e.claim === 'unverified' && e.underStation === true));
    const sum = R('company/work/changes/CHANGES.md'); for (const r of allRecs(C())) assert.ok(sum.includes('| ' + r.id + ' |'));
  });
  await t('self-governance at apply: budget at approve files one owner card at the last review, then applies after a yes', async () => {
    setGov('budget', 'approve');
    const r = await propose(C(), { kind: 'policy', target: 'pacing-policy.json', why: 'a slightly wider margin for the month end', change: '{"/marginPct": 7}', by: 'Jo' });
    review(C(), r.id, { by: 'Pat' }, 'approve');
    assert.strictEqual(openIn('pat', 'apply ' + r.id), 0, 'nobody is handed an apply while the owner decides');
    await assert.rejects(applyChange(C(), r.id, { by: 'Pat' }), /budget is at approve/);
    await assert.rejects(applyChange(C(), r.id, { by: 'Pat' }), /budget is at approve/);
    const asks = asksFor('harness-review:' + r.id);
    assert.strictEqual(asks.length, 1); assert.strictEqual(JSON.parse(R('company/work/finance/pacing-policy.json')).marginPct !== 7, true);
    const c = card.calls.filter(x => x.op === 'file' && x.card.ref === 'harness-review:' + r.id).pop().card;
    assert.ok(/^Jo wants to change a spending or pacing limit, and one colleague reviewed it\./.test(c.lead), c.lead); assert.ok(plainCheck(c)); assert.ok(/marginPct/.test(c.technical) && !/marginPct/.test(c.lead));
    ownerAnswer(asks[0].id, true);
    const a = await applyChange(C(), r.id, { by: 'Pat' }); assert.strictEqual(a.status, 'applied'); assert.strictEqual(JSON.parse(R('company/work/finance/pacing-policy.json')).marginPct, 7);
  });
  await t('self-governance at apply: tools at notify applies and puts one plain line in the digest (never a message); schedules/models/tools map from the kind', async () => {
    setGov('tools', 'notify');
    const before = fs.existsSync(path.join(T, 'company/owner/outbound.jsonl')) ? R('company/owner/outbound.jsonl') : '';
    const r = await propose(C(), { kind: 'tool', target: 'company/tools/sample.js', why: 'another note for the next reader of it', change: R('company/tools/sample.js').replace('const N = 1;', 'const N = 1; // notify'), by: 'Jo' });
    review(C(), r.id, { by: 'Max' }, 'approve'); const a = await applyChange(C(), r.id, { by: 'Max' }); assert.strictEqual(a.status, 'applied');
    const fyi = notice.sent.filter(x => x.key === 'harness-applied:' + r.id);
    assert.strictEqual(fyi.length, 1); assert.strictEqual(fyi[0].kind, 'fyi');
    assert.strictEqual(fyi[0].text, 'Jo changed one of the crew\'s shared tools, after one colleague reviewed it.'); assert.ok(/sample\.js/.test(fyi[0].technical));
    assert.strictEqual(fs.existsSync(path.join(T, 'company/owner/outbound.jsonl')) ? R('company/owner/outbound.jsonl') : '', before, 'no owner message');
    assert.strictEqual(asksFor('harness-review:' + r.id).length, 0);
    assert.deepStrictEqual(['schedule', 'model', 'house-rule'].map(k => governanceCategory({ kind: k })), ['schedules', 'models', 'tools']);
    assert.strictEqual(governanceCategory({ kind: 'policy', target: { file: 'company/model-policy.json' } }), 'tools');
    setGov('tools', 'auto'); setGov('budget', 'auto');
  });
  await t('a framework request carries the diff of a patch-mode change, and refuses to be written empty', async () => {
    const cpx = require('child_process'); const G = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-fw-'));
    try {
      const gw = (rel, v) => { fs.mkdirSync(path.dirname(path.join(G, rel)), { recursive: true }); fs.writeFileSync(path.join(G, rel), v); };
      gw('company/work/.founded', ''); gw('company/tools/fw.js', 'x\n'); gw('company/work/changes/hc-0001/change.diff', '--- a/company/tools/fw.js\n+++ b/company/tools/fw.js\n@@ -1 +1 @@\n-x\n+y\n');
      cpx.spawnSync('git', ['init', '-q'], { cwd: G }); cpx.spawnSync('git', ['add', 'company/tools/fw.js'], { cwd: G });
      const cx = context({ root: G, now: Date.now() });
      const rec = { id: 'hc-0001', kind: 'tool', by: 'Max', why: 'w', target: { type: 'file', file: 'company/tools/fw.js' }, change: { mode: 'patch', payload: 'company/work/changes/hc-0001/change.diff' }, status: 'approved', approvals: [] };
      assert.ok(requestPayload(cx, rec).includes('+y'), 'payload read from rec.change.payload');
      const r = frameworkRequest(cx, rec, { name: 'Max' });
      assert.ok(r && /^\+y$/m.test(fs.readFileSync(path.join(G, r.upstream), 'utf8')), 'the request file holds the diff');
      assert.strictEqual(r.upstream, 'company/work/framework-requests/fr-0001.md', 'framework requests have their own id sequence');
      assert.ok(/^- Company change: hc-0001 /m.test(fs.readFileSync(path.join(G, r.upstream), 'utf8')) && r.frameworkRequest === 'fr-0001', 'the request names the company change');
      const r2 = frameworkRequest(cx, Object.assign({}, rec, { id: 'hc-0003', status: 'approved', frameworkRequest: undefined }), { name: 'Max' });
      assert.strictEqual(r2.upstream, 'company/work/framework-requests/fr-0002.md', 'the next request takes the next number');
      const bad = Object.assign({}, rec, { id: 'hc-0002', change: { mode: 'patch', payload: 'company/work/changes/hc-0002/change.diff' }, status: 'approved' });
      assert.throws(() => frameworkRequest(cx, bad, { name: 'Max' }), /no change text/);
      assert.ok(fs.readdirSync(path.join(G, 'company/work/framework-requests')).length === 2 && bad.status === 'approved', 'nothing written, status unchanged');
    } finally { fs.rmSync(G, { recursive: true, force: true }); }
  });
  if (prevProv === undefined) delete process.env.PROVENANCE_ROOT; else process.env.PROVENANCE_ROOT = prevProv;
  fs.rmSync(T, { recursive: true, force: true });
  return { out, bad };
}

/* ---------------- CLI ---------------- */
const CLI = {
  propose: { pos: 0, val: ['kind', 'target', 'why', 'change', 'by', 'expect', 'replaces', 'plain'] }, approve: { pos: 1, val: ['by', 'note'] }, reject: { pos: 1, val: ['by', 'note'] },
  withdraw: { pos: 1, val: ['by', 'why'] }, apply: { pos: 1, val: ['by'] }, revert: { pos: 1, val: ['by', 'why'] }, keep: { pos: 1, val: ['by', 'note'] },
  'review-due': { pos: 0, val: [] }, list: { pos: 0, val: [], bool: ['all'] }, show: { pos: 1, val: [] }, tick: { pos: 0, val: [], bool: ['dry-run'] }, selftest: { pos: 0, val: [] },
};
function parseArgs(cmd, rest) {
  const s = CLI[cmd]; if (!s) return null;
  const o = {}, pos = [];
  for (let i = 0; i < rest.length; i++) {
    const x = String(rest[i]);
    if (!x.startsWith('--')) { pos.push(x); continue; }
    const k = x.slice(2);
    if ((s.bool || []).includes(k)) { o[k] = true; continue; }
    if (!s.val.includes(k)) throw new Error('unknown option ' + x + ' for ' + cmd + '; nothing was done');
    const v = rest[i + 1]; if (v == null || (String(v).startsWith('--') && k !== 'change')) throw new Error('--' + k + ' needs a value; nothing was done');
    o[k] = String(v); i++;
  }
  if (pos.length !== s.pos) throw new Error(cmd + (s.pos ? ' needs a change id (hc-0001)' : ' takes no plain arguments') + '; nothing was done');
  return { o, id: pos[0] };
}
if (require.main === module) {
  const a = process.argv.slice(2); const cmd = a[0];
  let P; try { P = parseArgs(cmd, a.slice(1)); } catch (e) { console.error('harness-change: ' + e.message); process.exit(2); }
  if (!P) { console.log('usage: harness-change.js propose --kind ' + KINDS.join('|') + ' --target … --why "…" --change <file or JSON> --by <Name> | approve|reject <id> --by <Name> [--note] | apply|revert|keep|withdraw <id> --by <Name> | review-due | list [--all] | show <id> | tick [--dry-run] | selftest'); process.exit(2); }
  const { o, id } = P;
  (async () => {
    if (cmd === 'selftest') { const { out, bad } = await selftest(); for (const l of out) console.log(l); console.log(bad ? bad + ' FAILED' : 'all ' + out.filter(l => l.startsWith('ok')).length + ' checks passed' + (out.some(l => l.startsWith('skip')) ? ' (' + out.filter(l => l.startsWith('skip')).length + ' skipped)' : '')); process.exit(bad ? 1 : 0); }
    const ctx = context({});
    const print = r => console.log(r.id + '  ' + r.status.padEnd(9) + ' ' + r.kind.padEnd(10) + ' ' + targetLabel(r) + '\n    by ' + r.by + ' · reviewers ' + r.reviewers.map(p => p.name + ((r.approvals || []).some(x => x.id === p.id) ? ' (approved)' : '')).join(', ') + (r.applier ? ' · applied by ' + r.applier.name : '') + '\n    ' + summaryLine(r) + '\n    why: ' + r.why);
    if (cmd === 'tick') { const r = await tick({ dry: !!o['dry-run'] }); console.log(JSON.stringify(r)); return; }
    if (cmd === 'list') { const recs = allRecs(ctx).filter(r => o.all || !['rejected', 'withdrawn', 'reverted', 'kept'].includes(r.status)); if (!recs.length) console.log(o.all ? 'no changes yet' : 'no open changes (list --all for the history)'); for (const r of recs) print(r); return; }
    if (cmd === 'show') { console.log(JSON.stringify(loadRec(ctx, id), null, 1)); return; }
    if (cmd === 'review-due') {
      const due = dueList(ctx); if (!due.length) console.log('no applied change has a results check due');
      for (const { rec, res } of due) { print(rec); console.log('    ' + res.scope + '\n    before (14 days): ' + fmtStat(res.before) + '\n    after:            ' + fmtStat(res.after) + '\n    looks ' + res.verdict + (res.notes.length ? ': ' + res.notes.join('; ') : '') + (res.confounded ? '\n    note: ' + res.confounded : '')); }
      return;
    }
    let r;
    if (cmd === 'propose') { r = await propose(ctx, o); if (r.again) { console.log('already proposed as ' + r.id + ' (the same change by the same person): the open record was updated, nothing new was filed'); print(r); return; } console.log('proposed ' + r.id + ' (claimed by ' + r.by + '; --by is not cryptographically verified). Review handoff sent to ' + r.reviewers.map(p => p.name).join(' and ') + '.'); print(r); return; }
    if (cmd === 'approve' || cmd === 'reject') { r = review(ctx, id, o, cmd); console.log((cmd === 'reject' ? 'rejected ' : 'approved ') + r.id + ' — now ' + r.status + (r.status === 'approved' ? '; apply handoff sent to ' + (r.applier ? r.applier.name : 'the reviewer') : '')); return; }
    if (cmd === 'withdraw') { r = withdraw(ctx, id, o); console.log('withdrew ' + r.id); return; }
    if (cmd === 'apply') { r = await applyChange(ctx, id, o); console.log('applied ' + r.id + (r.applied && r.applied.how ? ' (' + r.applied.how + ')' : '') + (r.judgeAfter ? '; results check due ' + r.judgeAfter.slice(0, 10) : (r.upstream ? '; not applied here, sent upstream as ' + r.upstream : ''))); return; }
    if (cmd === 'revert') { r = await revertChange(ctx, id, o); console.log('reverted ' + r.id); return; }
    if (cmd === 'keep') { r = keepChange(ctx, id, o); console.log('kept ' + r.id); return; }
  })().catch(e => { console.error('harness-change: ' + e.message); process.exit(e && ['who', 'input', 'state', 'stale', 'locked', 'refused'].includes(e.code) ? 2 : 1); });
}
