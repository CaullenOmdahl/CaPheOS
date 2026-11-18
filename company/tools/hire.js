#!/usr/bin/env node
/* hire.js — the company's hiring tool: open a round, create three candidate agents on different models, interview
 * them, hire one onto the station, and release the others. Run by the people function holder (loops.json functions:
 * people) from their hiring loop.
 *
 * The process: research what real job postings ask for and what makes people good at the role, decide which of the
 * company's models suit it, create three candidates, interview them, hire one, release the other two. Every step leaves
 * a file under company/hiring/<round>/.
 *
 *   node company/tools/hire.js open --round sales-lead-1 --role "Sales Lead" --by <name> [--manager <station id, default the CEO seat>] [--request "<who asked, why>"]
 *   node company/tools/hire.js candidate --round <r> --name ALEX --profile company/hiring/<r>/profiles/alex.md --by <name>
 *                                        [--provider <p> --model <model>] [--effort high]   (no model given: model-policy.json candidateDefault; the hire keeps the interviewed model)
 *        The profile is that candidate's personality written as an ideal candidate for the role, in the charter's
 *        headings (company/roles/templates/_charter-template.md: Personality, Backstory and motivation, Voice, Persona
 *        preset). The hired candidate's profile becomes part of their charter.
 *                                        [--skin <skin>] [--persona composed|warm|blunt|dry|upbeat]
 *        (no --skin: a free company candidate skin <slug>_candidate_*, else the station's default body DATA.DEFAULT_SKIN)
 *   node company/tools/hire.js interview --round <r> --questions company/hiring/<r>/interview.md [--agent <id>] [--background] [--redo] [--parallel 3]
 *                                        (all candidates at once, at most --parallel; skips candidates already interviewed or being
 *                                        interviewed; --redo writes <id>-2.md). Normally run by `advance`, not by hand.
 *   node company/tools/hire.js advance   <round> | --all [--held] [--dry] [--inline] [--parallel 3]
 *        moves a round as far as it goes without a judgement: creates the candidates whose profiles/<name>.md are written
 *        (optional "## Model" line provider/model), interviews them all in parallel in the background, writes
 *        scorecard-inputs.md, and hands the pick to the deciding seat as an OPEN handoff (scorecard, transcripts, a
 *        recommendation slot); a round's pickRule (open --pick-rule scores: scores.json totals) picks instead. A recorded
 *        pick is finished into the hire. The dispatcher runs `advance --all` every tick (--held: the metered cap is reached).
 *   node company/tools/hire.js pick      --round <r> --agent <id> --by <name> --why "<totals and why>" [--title ..] [--functions ..] [--template ..] [--access ask] [--name ..]
 *        the deciding seat's pick, recorded (scorecard.md, decisions.md, round log; the pick handoff closed); the hire
 *        (desk, loop, inbox, dossier, releases, the new seat's first-session handoff) follows at once under the hiring level
 *   node company/tools/hire.js open ... [--functions a,b] [--template <seat>] [--title ".."] [--pick-rule scores [--min 3.5]]
 *   node company/tools/hire.js hire      --round <r> --agent <id> --title "Sales Lead" --by <name> --approved "<who decided>, <where and when>" [--access full|ask]
 *                                        [--schedule "<cron expression>"] [--name <office name>]   (default: every 2 hours)
 *                                        [--template <seat>]   start the charter from company/roles/templates/<seat>.md
 *                                        [--functions people,tools]   the hire takes these utility functions from whoever holds them
 *   node company/tools/hire.js release   --round <r> --agent <id> --reason "<why not hired>" --by <name>
 *   node company/tools/hire.js remodel   --agent <id> --provider <p> --model <m> --by <name> --approved "<who decided>, <where and when>" [--reason "..."]
 *        (a seat with a model chain keeps its fallbacks, with the new model as primary; chains: company/tools/models.js)
 *   A hire's model chain (model-policy.json seats.<id>.chain) starts as [interviewed model, candidateDefault, a connected
 *   subscription model]; company/tools/models.js fails the seat over along it.
 *   node company/tools/hire.js fire      --agent <id> --reason "<why>" --by <name> --approved "<who decided>, <where and when>" [--replace]
 *        (fire: not the CEO; open handoffs and quests go to the manager; charter and inbox archived under company/hiring/former/;
 *         --replace opens a replacement round seeded from the old charter and hands it to the people owner)
 *   node company/tools/hire.js status    --round <r>
 *   node company/tools/hire.js models                      # which providers/models candidates can run on today
 *
 * Who decides (--approved must START with that person's runtime name): a people decision about someone is made by their
 * manager together with the people function holder; when the manager is the CEO, the people holder alone decides and
 * records it in company/work/decisions.md, where the CEO can overrule it. Changes that need the CEO name the CEO seat.
 *
 * Files a round expects (the people owner writes them): research.md (job postings with URLs, success traits),
 * role-spec.md (scope, out of scope, KPIs, reports to, success traits, sources), model-fit.md (why each candidate's
 * model), interview.md (questions: one per "## " heading), scorecard.md (rubric and scores). hire.js writes round.json,
 * log.md, interviews/<agentId>.md and company/roles/<name>.md for the hire.
 *
 * Self-governance (company/state/governance.json, lib/governance.js): open and hire are category hiring, fire (and releasing a
 * candidate from a round that hired nobody) is release, remodel is models. At approve the command exits 3 after filing one
 * owner question; run it again once the owner has answered yes. The spendCap guardrail off lets an interview past the cap.
 * Safety: candidates are created in approval mode "ask" and interviewed with NO tools (POST /api/run isTask:false), so a
 * candidate can only talk. The station page must be closed while this runs (see station-crew.js). Never prints secrets.
 * Owner of this tool: the tools function holder.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const C = require('./station-crew.js');
const co = require('./lib/company');
const gov = require('./lib/governance');
const ROOT = co.ROOT;
const HIRING = co.p('company', 'hiring');
const LOOPS = co.LOOPS_FILE;
const HANDOFFS = co.p('company', 'work', 'handoffs');
const ROLES = co.p('company', 'roles');
const TEMPLATES = co.p('company', 'roles', 'templates');
const FUNCTIONS = ['ceo', 'people', 'tools', 'risk', 'floor', 'finance'];
const companyName = () => co.config.name || 'the company';
const ownerName = () => (co.config.owner && co.config.owner.name) || 'the owner';
const ceoId = () => co.ceo();
const ceoName = () => co.nameOf(ceoId());
// the inbox file of whoever holds a function (falls back to the CEO seat, as co.seatFor does)
function inboxOf(id) { const c = co.crew()[id]; return (c && c.inbox) || 'to-' + String(id).toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.md'; }
const fnInbox = fn => inboxOf(co.seatFor(fn));
const SUITS = ['#6fb3bf', '#7bc88a', '#d99a5a', '#a888c0', '#cf7d96', '#ffd34a'];
// Candidate bodies: the company's own candidate skins (<company slug>_candidate_* in DATA.SKINS, drawn by the floor
// owner and installed with station-art.js), never stock or franchise art. With none free, the station's default body, DATA.DEFAULT_SKIN, read from
// starnet/frontend/app/data-shim.js each time (station-art.js set-default-skin points it at a company skin).
const SKINS_JS = path.join(ROOT, 'starnet', 'frontend', 'app', 'data-shim.js');
function candidateSkin(used) {
  let s = ''; try { s = fs.readFileSync(SKINS_JS, 'utf8'); } catch (_) {}
  const i = s.indexOf('DATA.SKINS = {'), j = s.indexOf('\n};', i);
  const keys = i < 0 || j < 0 ? [] : [...s.slice(i, j).matchAll(/^\s*([A-Za-z0-9_]+):\s*\{/gm)].map(m => m[1]);
  const def = (s.match(/^\s*DATA\.DEFAULT_SKIN\s*=\s*['"]([A-Za-z0-9_]+)['"]\s*;?/m) || [])[1];   // a trailing comment or spacing still reads
  const prefix = String(co.config.slug || 'company').replace(/[^A-Za-z0-9_]/g, '_') + '_candidate_';
  return keys.find(k => k.startsWith(prefix) && !(used && used.has(k))) || def || 'blank';   // 'blank' is StarNet's own default key, if data-shim.js cannot be read
}
const TURN_TIMEOUT_MS = 12 * 60 * 1000;
// The metered budget, applied the same way the dispatcher applies it (company/work/finance/dispatch-budget.json).
// An interview is one of the most expensive things a company does per run — a 6-question interview is 6 model calls —
// so hire.js must not be the one tool that can spend on a day the dispatcher has capped. Refuses by default, --force
// overrides.
// HIRE_BUDGET_FILE / HIRE_RUNS_FILE exist so a test can point the guard at a fixture instead of the live meter.
const BUDGET_FILE = process.env.HIRE_BUDGET_FILE || co.p('company', 'work', 'finance', 'dispatch-budget.json');
const RUNS_FILE = process.env.HIRE_RUNS_FILE || co.p('.starnet-data', 'workspaces', 'runs.jsonl');
function budgetState(f) {
  f = f || {};
  let b = {};
  try { b = JSON.parse(fs.readFileSync(f.budgetFile || BUDGET_FILE, 'utf8')) || {}; } catch (_) {}
  const cap = typeof b.dailyUsd === 'number' ? b.dailyUsd : 2;
  const share = typeof b.perAgentUsd === 'number' && b.perAgentUsd > 0 ? b.perAgentUsd : 0;
  const unmetered = (Array.isArray(b.unmeteredProviders) && b.unmeteredProviders.length ? b.unmeteredProviders : ['claude-cli']).map(String);
  const since = Date.now() - 24 * 3600 * 1000;
  let total = 0; const byAgent = {};
  try {
    for (const l of require('./lib/bounded').jsonlWindowText(f.runsFile || RUNS_FILE, since).split('\n')) {   // the last 24 h only, read from the end
      if (!l) continue;
      let r; try { r = JSON.parse(l); } catch (_) { continue; }
      if (!(r.startedAt >= since)) continue;                    // unmetered runs record usd:0 and are skipped by provider
      if (unmetered.includes(String(r.provider || ''))) continue;
      const u = Number(r.usd) || 0;
      total += u;
      if (r.agentId) byAgent[r.agentId] = (byAgent[r.agentId] || 0) + u;
    }
  } catch (_) {}
  return { cap, share, total, byAgent, unmetered };
}
// Throws unless there is room. `who` is the station id whose share is checked (the hiring manager doing the round).
// The spendCap guardrail (company/state/guardrails.json, co.guard): while it is off the cap holds nothing; the tool says
// that it would have refused and goes on.
function assertBudget(who, force, gopts) {
  const st = budgetState(gopts);
  const over = st.total >= st.cap;
  const shareOver = st.share > 0 && (st.byAgent[who] || 0) >= st.share;
  if ((over || shareOver) && !force && !gov.guard('spendCap', gopts)) {
    st.guardOff = 'the spendCap guardrail is off: the metered cap would have stopped this ($' + st.total.toFixed(2) + ' of $' + st.cap.toFixed(2) + ')';
    try { process.stderr.write('hire.js: ' + st.guardOff + '\n'); } catch (_) {}
    return st;
  }
  if ((over || shareOver) && !force) {
    const why = over
      ? 'the 24h metered cap is reached ($' + st.total.toFixed(2) + ' of $' + st.cap.toFixed(2) + ')'
      : who + ' is at its $' + st.share.toFixed(2) + '/24h share ($' + (st.byAgent[who] || 0).toFixed(2) + ')';
    out(3, { ok: false, error: 'budget: ' + why + ' per ' + path.relative(ROOT, BUDGET_FILE) + '. An interview is 6+ paid model calls, so nothing was started. Wait for the meter to roll off, or pass --force if this round is worth it.' });
  }
  return st;
}
// The owner's model list is company/model-policy.json: `allowed` (provider -> { models }) is the only set a candidate,
// a hire or a model change may run on; a hire keeps the model they interviewed on. Optional keys read here:
// `candidateDefault` { provider, model, effort } for a candidate with no model given (else the first allowed model), and
// `needsCeoApproval` (model ids) for models a remodel may move someone to only with the CEO named in --approved.
const modelPolicy = () => readJson(co.p('company', 'model-policy.json'), {}) || {};
function companyModel() {
  const pol = modelPolicy(); const d = pol.candidateDefault || {};
  if (d.provider && d.model) return { provider: String(d.provider), model: String(d.model), effort: d.effort ? String(d.effort) : 'high' };
  const first = Object.entries(pol.allowed || {}).find(([, f]) => f && Array.isArray(f.models) && f.models.length);
  return first ? { provider: first[0], model: String(first[1].preferred || first[1].models[0]), effort: 'high' } : { provider: '', model: '', effort: 'high' };
}
const hireProviders = () => Object.keys(modelPolicy().allowed || {});
function policyCheck(provider, model) {
  const pol = modelPolicy().allowed || {};
  const fam = pol[provider];
  if (!fam || !Array.isArray(fam.models) || !fam.models.includes(model))
    return 'model ' + provider + '/' + model + ' is not allowed by company/model-policy.json. Allowed: ' + Object.entries(pol).map(([p, f]) => p + ' ' + (f.models || []).join('|')).join('; ');
  return null;
}
function crewRows() { return co.crew(); }
function nameOf(id) { const c = crewRows()[id]; return c ? c.name : null; }
const peopleId = () => co.seatFor('people');
// who may decide a people matter about someone with this manager: their manager with the people owner, or the people
// owner alone when the manager is the CEO
function deciders(managerId) {
  const hrName = co.nameOf(peopleId());
  return (!managerId || managerId === ceoId()) ? [hrName] : [...new Set([nameOf(managerId), hrName].filter(Boolean))];
}
// --approved must START with the name of someone allowed to decide (e.g. "Sam, decisions.md 2026-01-02 10:00")
// Names may be several words ("Marisol Vance"): the text must start with the full name, or with its first word followed
// by a separator (so "Marisol, …" still counts) — never just a prefix of another name ("Mari" is not "Marisol Vance").
function approverOk(text, allowed) {
  const t = String(text || '').trim().toLowerCase();
  return (allowed || []).some(n => {
    const full = String(n || '').trim().toLowerCase(); if (!full) return false;
    const first = full.split(/\s+/)[0];
    const startsWithWord = w => t.startsWith(w) && (t.length === w.length || /[^a-z0-9]/.test(t.charAt(w.length)));
    return startsWithWord(full) || startsWithWord(first);
  });
}
// Self-governance (company/state/governance.json via lib/governance.js): hiring for open/hire, release for fire and for
// releasing a candidate from a round that hired nobody, models for remodel. At approve the act waits for the owner: the
// first call files one owner question (keyed by `ref`), and the same command run again after the owner says yes goes on.
/* ASKS: what each governed act says to the owner (lib/governance.js decide): a plain summary, recommendation and default;
 * the ids, models, versions and the --approved reference go in `technical`. Exported so a test files each at approve. */
const plainWhy = t => { const x = t && t !== true ? gov.plainPart(String(t).replace(/\s+/g, ' ').trim().replace(/[.!]$/, '').slice(0, 200)) : null; return x ? x.replace(/^./, c => c.toLowerCase()) : null; };
const ASKS = {
  hire: ({ name, title, provider, model, round, agentId, approved }) => ({ summary: 'hire ' + name + (gov.plainPart('as ' + title) ? ' as ' + title : ' for the open job'),
    recommendation: 'yes', default: 'nobody is hired and the candidates wait',
    technical: 'Candidate ' + agentId + ' (' + provider + '/' + model + ') from hiring round ' + round + ', as ' + title + '. Approved: ' + approved }),
  remodel: ({ name, agentId, provider, model, reason, approved }) => ({ summary: 'change which AI ' + name + ' works with',
    recommendation: 'yes' + (plainWhy(reason) ? ': ' + plainWhy(reason) : ''), default: name + ' keeps the AI they use now',
    technical: 'Move ' + agentId + ' to the model ' + provider + '/' + model + (reason && reason !== true ? ' (' + String(reason).slice(0, 160) + ')' : '') + '. Approved: ' + approved }),
  fire: ({ name, title, agentId, reason, replace, approved }) => ({ summary: 'let ' + name + ' go' + (replace ? ' and look for someone to replace them' : ''),
    recommendation: 'yes' + (plainWhy(reason) ? ': ' + plainWhy(reason) : ''), default: name + ' stays on the crew',
    technical: 'Release ' + agentId + ' (' + title + ')' + (replace ? ' and open a replacement round' : '') + ': ' + String(reason).slice(0, 200) + '. Approved: ' + approved }),
  releaseCandidate: ({ name, role, round, agentId, reason }) => ({ summary: 'turn down ' + name + (gov.plainPart('for the ' + role + ' job') ? ' for the ' + role + ' job' : '') + ' before anyone is hired',
    recommendation: plainWhy(reason) ? 'yes: ' + plainWhy(reason) : null, default: name + ' stays a candidate',
    technical: 'Release candidate ' + agentId + ' from hiring round ' + round + ' (nobody hired yet): ' + String(reason).slice(0, 160) }),
  open: ({ role, slug, request }) => ({ summary: 'start looking for ' + (gov.plainPart('a new ' + role) ? 'a new ' + role : 'a new crew member'),
    recommendation: 'yes' + (plainWhy(request) ? ': ' + plainWhy(request) : ''), default: 'nobody new is looked for',
    technical: 'Open hiring round ' + slug + ' for a ' + role + (request && request !== true ? ': ' + String(request).slice(0, 200) : '') }),
};
function governanceCheck(category, o, gopts) {
  const d = gov.decide(category, o, gopts);
  return d.allowed ? { ok: true, d } : { ok: false, d, error: gov.refusal(category, d) };
}
function mustGovern(category, o) {
  const g = governanceCheck(category, o);
  if (!g.ok) out(3, { ok: false, error: g.error, governance: { category, level: g.d.level, questionId: g.d.questionId || null, denied: !!g.d.denied } });
  return g.d;
}
function staffLog(line) { const f = path.join(HIRING, 'staff-log.md'); if (!fs.existsSync(f)) fs.writeFileSync(f, '# Staff log\n\nHires, model changes and departures. Written by company/tools/hire.js.\n\n'); fs.appendFileSync(f, '- ' + stamp() + ' ' + line + '\n'); }

function args() {
  const a = process.argv.slice(2); const o = { cmd: a[0] || 'status' };
  for (let i = 1; i < a.length; i++) {
    if (!a[i].startsWith('--')) { if (o._ === undefined) o._ = a[i]; continue; }
    const k = a[i].slice(2);
    o[k] = (a[i + 1] !== undefined && !a[i + 1].startsWith('--')) ? a[++i] : true;
  }
  return o;
}
// out() ends the process with a JSON line; inside soft() (advance, pick, the dispatcher's mechanical steps) it throws a
// Stop instead, so one refused step is a note on that round, not the end of the run.
let SOFT = 0;
class Stop extends Error { constructor(code, obj) { super(String((obj && obj.error) || 'stopped')); this.code = code; this.obj = obj || {}; } }
const out = (code, obj) => { if (SOFT) throw new Stop(code, obj); console.log(JSON.stringify(obj, null, 1)); process.exit(code); };
async function soft(fn) {
  SOFT++;
  try { return { ok: true, value: await fn() }; }
  catch (e) { return e instanceof Stop ? { ok: false, code: e.code, obj: e.obj, error: e.message } : { ok: false, code: 1, obj: {}, error: String(e && e.message || e) }; }
  finally { SOFT--; }
}
// run fn over items with at most n in flight; results in input order
async function pool(items, n, fn) {
  const res = new Array(items.length); let next = 0;
  const lane = async () => { while (next < items.length) { const k = next++; res[k] = await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(Number(n) || 1, items.length)) }, lane));
  return res;
}
const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fb; } };
// whole-file replace (write a temp file, rename it over): loops.json is read by the dispatcher and station-floor.js at any
// moment, and an in-place write lets them read it half-written
const writeJson = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); const tmp = p + '.tmp-' + process.pid; const txt = JSON.stringify(o, null, 1) + '\n'; fs.writeFileSync(tmp, txt); fs.renameSync(tmp, p); if (p === LOOPS) { try { require('./provenance.js').wrote(p, txt, 'hire.js'); } catch (_) {} }; };
const stamp = () => { const t = co.localParts(); return t.date + ' ' + t.time; };   // company time (co.TZ)
const ROUND_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
function roundDir(r) { if (!ROUND_RE.test(String(r || ''))) out(2, { ok: false, error: '--round must be lowercase letters, digits and dashes, e.g. sales-lead-1' }); return path.join(HIRING, r); }
function loadRound(r) { const d = roundDir(r); const j = readJson(path.join(d, 'round.json'), null); if (!j) out(2, { ok: false, error: 'no round ' + r + ' (run: hire.js open)' }); return { dir: d, round: j }; }
function saveRound(dir, round) { writeJson(path.join(dir, 'round.json'), round); }
// Change round.json under a short lock, re-reading it first: several hire.js processes (one interview per candidate,
// plus the people owner's own commands) write this file, and whole-file saves from stale copies lost a candidate's record.
function mutateRound(dir, fn) {
  const lock = path.join(dir, '.round.lock');
  for (let i = 0; i < 50; i++) {
    try { fs.closeSync(fs.openSync(lock, 'wx')); break; }
    catch (_) { try { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) fs.unlinkSync(lock); } catch (__) {} const t = Date.now() + 100; while (Date.now() < t) {} }
  }
  try { const r = readJson(path.join(dir, 'round.json'), null); if (!r) throw new Error('round.json unreadable'); fn(r); saveRound(dir, r); return r; }
  finally { try { fs.unlinkSync(lock); } catch (_) {} }
}
function transcriptDone(dir, agentId) { return /^Finished /m.test(readIf(path.join(dir, 'interviews', agentId + '.md'), 1e7)); }
function logLine(dir, line) { fs.appendFileSync(path.join(dir, 'log.md'), '- ' + stamp() + ' ' + line + '\n'); }
function need(a, k) { if (!a[k] || a[k] === true) out(2, { ok: false, error: '--' + k + ' is required' }); return String(a[k]); }
function readIf(p, n) { try { return fs.readFileSync(p, 'utf8').slice(0, n || 6000); } catch (_) { return ''; } }

// POST /api/run with no tools; returns the lead run's text. Keeps the socket open (closing it aborts the run).
function runTurn(agentId, model, provider, messages, streamId) {
  // the one gate (lib/admit.js, door hire): phase 1 always allows and records each interview turn; the budget check above
  // (budgetState) still decides whether interviews start at all
  const tk = require('./lib/admit').admit({ door: 'hire', kind: 'run', seat: agentId, why: 'interview turn ' + streamId });
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ agentId, model, provider, rosterSystem: true, client: 'terminal', isTask: false, streamId, messages });
    const station = new URL(co.STATION_URL);
    let token; try { token = co.stationToken(); } catch (e) { reject(e); return; }
    const req = http.request({ hostname: station.hostname, port: station.port || 80, path: '/api/run', method: 'POST',
      headers: { 'x-starnet-token': token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      require('./lib/admit').started(tk, { status: res.statusCode });
      if (res.statusCode !== 200) { let d = ''; res.on('data', c => d += c); res.on('end', () => reject(new Error('HTTP ' + res.statusCode + ' ' + d.slice(0, 200)))); return; }
      let buf = '', lead = null, text = '', end = null;
      res.on('data', c => {
        buf += c; let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
          const p = ev.payload || {};
          if (ev.name === 'agent.run.start' && !lead) lead = p.runId;
          if (ev.name === 'agent.token' && p.runId === lead && typeof p.delta === 'string') text += p.delta;
          if (ev.name === 'agent.run.end' && p.runId === lead) end = p;
        }
      });
      res.on('end', () => resolve({ text: text.trim(), runId: lead, reason: end && (end.reason || end.outcome), outcome: end && end.outcome, failureCode: end && end.failureCode, usd: end && end.usd }));
      res.on('error', reject);
    });
    req.setTimeout(TURN_TIMEOUT_MS, () => req.destroy(new Error('turn timed out after ' + (TURN_TIMEOUT_MS / 60000) + ' min')));
    req.on('error', reject);
    req.write(body); req.end();
  });
}

const sec = (txt, h) => { const m = String(txt).match(new RegExp('## ' + h + '[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)')); return m ? m[1].replace(/<!--[\s\S]*?-->/g, '').trim() : ''; };
function candidateDocs(name, role, spec, profile) {
  const who = [sec(profile, 'Personality') && 'Your personality: ' + sec(profile, 'Personality'), sec(profile, 'Backstory') && 'Your background: ' + sec(profile, 'Backstory'), sec(profile, 'Voice') && 'How you speak and write: ' + sec(profile, 'Voice')].filter(Boolean).join('\n\n');
  return {
    identity: 'You are ' + name + ', a candidate interviewing for the role of ' + role + ' at ' + companyName() + ', an AI-run company owned by ' + ownerName() + '. ' + co.nameOf(peopleId()) + ', who runs hiring, is interviewing you. Answer as the professional you would be in this job: concrete, honest about what you do not know, and specific to this company and its customers. You have no tools in this interview; work from what you know and say when something would need checking.' + (who ? '\n\n' + who : ''),
    purpose: 'The role you are interviewing for, as written by the company:\n\n' + (spec || '(no role spec yet)').slice(0, 5000),
    manual: '', context: '',
  };
}

async function createCandidate(a) {
  const { dir, round } = loadRound(need(a, 'round'));
  const name = need(a, 'name'), by = need(a, 'by');
  const dflt = companyModel();
  const provider = a.provider && a.provider !== true ? String(a.provider) : dflt.provider;
  const model = a.model && a.model !== true ? String(a.model) : dflt.model;
  if (!a.effort) a.effort = dflt.effort;
  if (!hireProviders().includes(provider)) out(2, { ok: false, error: 'candidates run on a provider allowed in company/model-policy.json (' + (hireProviders().join(', ') || 'none listed') + '); not ' + (provider || '(none)') });
  { const bad = policyCheck(provider, model); if (bad) out(2, { ok: false, error: bad }); }
  const active = (round.candidates || []).filter(c => c.status === 'candidate');
  if (active.length >= 3) out(2, { ok: false, error: 'this round already has 3 active candidates' });
  const spec = readIf(path.join(dir, 'role-spec.md'), 8000);
  if (!spec.trim()) out(2, { ok: false, error: 'write ' + path.relative(ROOT, path.join(dir, 'role-spec.md')) + ' first' });
  const M = C.appModules();
  const AgentId = require(path.join(ROOT, 'starnet', 'frontend', 'app', 'agentid.js'));
  const issue = AgentId.nameIssue(name); if (issue) out(2, { ok: false, error: 'name: ' + issue });
  const profile = a.profile && a.profile !== true ? readIf(path.resolve(ROOT, String(a.profile)), 8000) : '';
  if (a.profile && !profile.trim()) out(2, { ok: false, error: 'cannot read --profile ' + a.profile });
  const presetFromProfile = sec(profile, 'Persona preset').toLowerCase().split(/\s+/)[0];
  const persona = a.persona && M.Personas.exists(String(a.persona)) ? String(a.persona) : (presetFromProfile && M.Personas.exists(presetFromProfile) ? presetFromProfile : 'composed');
  let created = null;
  await C.editSave(doc => {
    const taken = new Set([...C.rows(doc).keys()]);
    for (const r of fs.readdirSync(HIRING)) for (const c of ((readJson(path.join(HIRING, r, 'round.json'), {}) || {}).candidates || [])) taken.add(c.agentId);
    try { for (const f of fs.readdirSync(path.join(ROOT, '.starnet-data', 'workspaces', '_archive'))) taken.add(f.replace(/-\d{10,}$/, '')); } catch (_) {}
    const id = AgentId.alloc('cand-' + round.slug + '-' + name, taken);
    const used = new Set([...C.rows(doc).values()].map(x => x.skin));
    const skin = a.skin && typeof a.skin === 'string' ? a.skin : candidateSkin(used);
    const rec = { id, name: AgentId.normalizeName(name), color: SUITS[(doc.agents || []).length % SUITS.length], skin, model, provider,
      reasoningEffort: a.effort ? String(a.effort) : null, personaId: persona, role: 'specialist', voiceTraits: null, customVoice: '',
      approvalMode: 'ask', executionProfile: 'trusted-project', workshop: false, purpose: 'Candidate: ' + round.role, specialtyId: null,
      docs: candidateDocs(AgentId.normalizeName(name), round.role, spec, profile), skills: [], stats: null, createdAt: Date.now() };
    if (sec(profile, 'Voice')) rec.customVoice = sec(profile, 'Voice').replace(/\s+/g, ' ').slice(0, 600);
    doc.agents = (doc.agents || []).concat([rec]);
    created = rec;
  }, 'hire-candidate');
  // the roster row, so the station can run the candidate before any page opens
  const { doc } = await C.getSave();
  const { system } = C.compose(doc, created.id);
  const rows = C.rosterRows();
  const row = { agentId: created.id, system, name: created.name, model, provider, role: 'Candidate: ' + round.role, approvalMode: 'ask',
    executionProfile: 'trusted-project', skills: [], reasoningEffort: created.reasoningEffort, track: '', workshop: false };
  const r = await C.call('POST', '/api/roster', { agents: rows.filter(x => x.agentId !== created.id).concat([row]), updatedAt: Date.now() });
  if (r.status !== 200 || !/"ok":true/.test(r.body)) throw new Error('roster push failed: ' + r.body.slice(0, 200));
  // The model pin rides the roster row above (and the save row). POST /api/agent/model is not used: with a station page
  // open it is answered by the page, which does not know a candidate created headlessly.
  mutateRound(dir, r => { r.candidates = (r.candidates || []).concat([{ agentId: created.id, name: created.name, provider, model, effort: created.reasoningEffort, skin: created.skin, persona, profile: a.profile && a.profile !== true ? String(a.profile) : null, status: 'candidate', createdAt: new Date().toISOString(), createdBy: by }]); });
  logLine(dir, 'CANDIDATE ' + created.name + ' (' + created.id + ') on ' + provider + '/' + model + ' created by ' + by);
  return { ok: true, agentId: created.id, name: created.name, provider, model, skin: created.skin, approvalMode: 'ask' };
}

function parseQuestions(file) {
  const txt = fs.readFileSync(path.resolve(ROOT, file), 'utf8');
  const qs = txt.split(/^## /m).slice(1).map(s => s.trim()).filter(Boolean).map(s => s.replace(/^[^\n]*\n?/, m => '**' + m.trim() + '**\n'));
  if (!qs.length) out(2, { ok: false, error: 'no questions: put each one under its own "## " heading' });
  return qs;
}
/* one interview turn; a turn the model refused (lib/refusal.js, owner ruling) is asked again ONCE on the next model, and the
 * transcript says so, so the scorecard never reads a declined answer as the candidate's. run: runTurn (a seam for the tests) */
async function answerTurn(cand, messages, streamId, run) {
  const REF = require('./lib/refusal');
  const res = await run(cand.agentId, cand.model, cand.provider, messages, streamId);
  if (!REF.isRefusal(res)) return res;
  const from = { provider: cand.provider, model: cand.model };
  const next = REF.nextEntry(null, from, [], { root: ROOT });
  if (!next) { REF.record({ root: ROOT, seat: cand.agentId, door: 'interview', runId: res.runId, from, to: null }); return Object.assign({}, res, { text: '(no answer: ' + REF.plainLine(from, null) + ')' }); }
  const again = await run(cand.agentId, next.model, next.provider, messages, streamId);
  REF.record({ root: ROOT, seat: cand.agentId, door: 'interview', runId: res.runId, retryRunId: again.runId, from, to: next });
  if (REF.isRefusal(again)) return Object.assign({}, again, { text: '(no answer: ' + REF.pname(from.provider) + ' and ' + REF.pname(next.provider) + ' both declined this question)' });
  return Object.assign({}, again, { usd: (Number(res.usd) || 0) + (Number(again.usd) || 0), note: REF.plainLine(from, next) + ' This answer is ' + REF.keyOf(next) + '\'s, not ' + REF.keyOf(from) + '\'s.' });
}
async function interviewOne(dir, round, cand, questions) {
  let f = path.join(dir, 'interviews', cand.agentId + '.md');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  for (let n = 2; fs.existsSync(f); n++) f = path.join(dir, 'interviews', cand.agentId + '-' + n + '.md');   // a redo never overwrites
  const running = path.join(dir, 'interviews', cand.agentId + '.running');
  fs.writeFileSync(running, String(process.pid));
  fs.writeFileSync(f, '# Interview: ' + cand.name + ' (' + cand.provider + '/' + cand.model + ') for ' + round.role + '\n\nStarted ' + stamp() + '. No tools; answers are the candidate\'s own.\n\n');
  const messages = []; let usd = 0;
  for (let i = 0; i < questions.length; i++) {
    messages.push({ role: 'user', content: questions[i] });
    let res;
    try { res = await answerTurn(cand, messages, 'interview-' + round.slug + '-' + cand.agentId, runTurn); }
    catch (e) { fs.appendFileSync(f, '## Question ' + (i + 1) + '\n\n' + questions[i] + '\n\n**No answer:** ' + e.message + '\n\n'); logLine(dir, 'INTERVIEW ' + cand.name + ' question ' + (i + 1) + ' failed: ' + e.message); try { fs.unlinkSync(running); } catch (_) {} return { agentId: cand.agentId, ok: false, error: e.message }; }
    messages.push({ role: 'assistant', content: res.text || '(no answer)' });
    usd += Number(res.usd) || 0;
    fs.appendFileSync(f, '## Question ' + (i + 1) + '\n\n' + questions[i] + '\n\n### Answer\n\n' + (res.note ? '> ' + res.note + '\n\n' : '') + (res.text || '(no answer)') + '\n\n_run ' + res.runId + ', ' + (res.reason || '?') + '_\n\n');
  }
  fs.appendFileSync(f, 'Finished ' + stamp() + '.\n');
  try { fs.unlinkSync(running); } catch (_) {}
  cand.interviewedAt = new Date().toISOString(); cand.transcript = path.relative(ROOT, f);
  logLine(dir, 'INTERVIEW ' + cand.name + ' done: ' + questions.length + ' questions, ' + path.relative(ROOT, f));
  return { agentId: cand.agentId, ok: true, transcript: path.relative(ROOT, f), usd };
}
async function interview(a) {
  const { dir, round } = loadRound(need(a, 'round'));
  const qfile = need(a, 'questions');
  const questions = parseQuestions(qfile);
  const budget = assertBudget(a.who || peopleId() || round.manager || ceoId(), !!a.force);
  logLine(dir, 'BUDGET ok before interviews: $' + budget.total.toFixed(2) + ' of $' + budget.cap.toFixed(2) + ' metered in the last 24h' + (a.force ? ' (--force)' : ''));
  const isRunning = c => interviewRunning(dir, c);
  const targets = (round.candidates || []).filter(c => c.status === 'candidate' && (!a.agent || c.agentId === a.agent)
    && (a.redo || !(c.interviewedAt || transcriptDone(dir, c.agentId))) && !isRunning(c));
  const parallel = Math.max(1, Math.min(6, Number(a.parallel) || INTERVIEW_PARALLEL));
  if (!targets.length) out(2, { ok: false, error: 'nobody to interview: every active candidate is already interviewed or being interviewed (use --agent <id> --redo to repeat one)' });
  if (a.background) {
    const logf = path.join(dir, 'interview-run.log');
    const argv = [__filename, 'interview', '--round', round.slug, '--questions', qfile, '--parallel', String(parallel)].concat(a.agent ? ['--agent', String(a.agent)] : []).concat(a.redo ? ['--redo'] : []).concat(a.force ? ['--force'] : [])
      .concat(a.advance ? ['--advance'] : ['--notify']);
    mutateRound(dir, r => { for (const c of r.candidates || []) if (targets.some(t => t.agentId === c.agentId)) c.interviewStartedAt = new Date().toISOString(); });
    // systemd-run --user --scope puts the process in its own scope, outside starnet.service (and the dispatcher's timer
    // unit), so a station restart (KillMode=mixed) does not kill an interview halfway. Needs a user bus; falls back to a
    // plain detached child (also with HIRE_NO_SCOPE=1, as the tests run).
    const bus = process.env.XDG_RUNTIME_DIR && fs.existsSync(path.join(process.env.XDG_RUNTIME_DIR, 'bus'));
    const hasSystemdRun = process.env.HIRE_NO_SCOPE !== '1' && bus && (() => { try { require('child_process').execFileSync('systemd-run', ['--version'], { stdio: 'ignore' }); return true; } catch (_) { return false; } })();
    const child = hasSystemdRun
      ? spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--unit', 'hire-interview-' + round.slug + '-' + Date.now(), process.execPath].concat(argv), { cwd: ROOT, detached: true, stdio: ['ignore', fs.openSync(logf, 'a'), fs.openSync(logf, 'a')] })
      : spawn(process.execPath, argv, { cwd: ROOT, detached: true, stdio: ['ignore', fs.openSync(logf, 'a'), fs.openSync(logf, 'a')] });
    child.unref();
    logLine(dir, 'INTERVIEWS started in the background (pid ' + child.pid + ', ' + Math.min(parallel, targets.length) + ' at a time) for ' + targets.map(c => c.name).join(', '));
    return { ok: true, background: true, pid: child.pid, parallel, candidates: targets.map(c => c.agentId), log: path.relative(ROOT, logf),
      note: 'Each answer is written to interviews/<agentId>.md as it arrives. When every active candidate has been interviewed, the pick is handed to ' + pickSeats(round).map(co.nameOf).join(' and ') + ' (an OPEN handoff) and the dispatcher wakes them.' };
  }
  // every candidate of the round at once (bounded by --parallel, default 3): an interview is a few minutes of waiting on
  // one model, and the candidates do not depend on each other
  mutateRound(dir, r => { for (const c of r.candidates || []) if (targets.some(t => t.agentId === c.agentId) && !c.interviewStartedAt) c.interviewStartedAt = new Date().toISOString(); });
  const results = await pool(targets, parallel, async c => {
    const r = await interviewOne(dir, round, c, questions);
    mutateRound(dir, fr => { const fc = (fr.candidates || []).find(x => x.agentId === c.agentId); if (!fc) return;
      if (r.ok) { fc.interviewedAt = c.interviewedAt; fc.transcript = c.transcript; delete fc.interviewError; }
      else { fc.interviewFailures = (Number(fc.interviewFailures) || 0) + 1; fc.interviewError = String(r.error || '').slice(0, 300); fc.interviewFailedAt = new Date().toISOString(); } });
    return r;
  });
  if (a.advance) {
    // the background run of hire.js advance: move the round on now (scorecard inputs, the pick handoff or the rule's pick,
    // the hire), instead of waiting for the next dispatcher tick
    const adv = await soft(() => advanceRound(round.slug, { noInterviews: true }));
    return { ok: results.every(r => r.ok), parallel, results, advance: adv.ok ? adv.value : { error: adv.error } };
  }
  if (a.notify) {
    const now = readJson(path.join(dir, 'round.json'), round);
    const active = (now.candidates || []).filter(c => c.status === 'candidate');
    const pending = active.filter(c => !(c.interviewedAt || transcriptDone(dir, c.agentId)));
    const failed = results.filter(r => !r.ok);
    const done = active.filter(c => !pending.includes(c));
    const allIn = !pending.length && !failed.length;
    // the pick is made with the role's manager; when that is the CEO, the people owner picks and records it (the CEO is not asked)
    const crewNow = co.crew();
    const mgrId = now.manager || round.manager || ceoId();
    const mgr = crewNow[mgrId];
    const pickLine = (mgrId === ceoId() || !mgr || mgrId === peopleId())
      ? 'make the pick yourself (the role reports to ' + (mgr ? mgr.name : 'the CEO') + '), record it as one dated row in company/work/decisions.md with `node company/tools/decision.js add --by <you> --text "..." --why "..."`, where the CEO can overrule it, then run hire.js hire for one and release for the others. Do not send it to the CEO.'
      : 'send ' + mgr.name + ' your recommendation (who, why, scores, scorecard link) in company/work/handoffs/' + mgr.inbox + ' and agree the pick with them; run hire.js hire and release once they answer.';
    const block = '\n## ' + stamp().slice(0, 10) + ' from hire.js — ' + round.role + ' round (' + round.slug + '): ' + (allIn ? 'every interview is in' : done.map(c => c.name).join(', ') + ' interviewed; ' + (pending.map(c => c.name).join(', ') || 'none') + ' still to go') + '\n' +
      '**Need:** ' + (allIn ? 'score every transcript against the role-spec criteria in company/hiring/' + round.slug + '/scorecard.md, then ' + pickLine
        : 'nothing yet unless an interview failed; you are woken again when every active candidate has been interviewed.') + '\n' +
      '**Why:** the round finishes with scoring, the pick, one hire and the release of the others.\n**Deadline:** ' + (allIn ? stamp().slice(0, 10) : 'none') + '\n' +
      '**Status:** ' + (allIn || failed.length ? 'OPEN' : 'DONE — progress note only') + '\n**Evidence:** ' + results.map(r => r.ok ? '`' + r.transcript + '`' : r.agentId + ' failed: ' + r.error).join('; ') + '\n';
    fs.mkdirSync(HANDOFFS, { recursive: true });
    fs.appendFileSync(path.join(HANDOFFS, fnInbox('people')), block);
  }
  return { ok: results.every(r => r.ok), parallel, results };
}

/* ---------------- advance: the round moves on its own ----------------
 * Every step of a round that needs no judgement is done by `hire.js advance` (the dispatcher runs it each tick, within
 * the halt state and the metered cap): create the candidates whose profiles are written, interview every candidate in
 * parallel, write the scorecard inputs when the interviews are in, and hand the pick to the seat that decides (an OPEN
 * handoff with the scorecard, the transcripts and a recommendation slot). The pick stays a judgement of that seat,
 * recorded with `hire.js pick`, or follows the round's own scorecard rule (round.json pickRule). Once a pick is
 * recorded the hire is finished at once, under the hiring governance level (auto: done; notify: done, the owner is
 * told; approve: the owner is asked, and the next advance after their yes finishes it). */
const INTERVIEW_PARALLEL = 3;
const MAX_INTERVIEW_TRIES = 2;      // a candidate whose interview failed this often is left out of the pick, not retried forever
const FINISH_LEASE_MS = 10 * 60e3;  // one hire.js finishes a pick at a time
const relp = f => path.relative(ROOT, f);
function interviewRunning(dir, c) { try { const pid = Number(fs.readFileSync(path.join(dir, 'interviews', c.agentId + '.running'), 'utf8')); if (!pid) return false; process.kill(pid, 0); return true; } catch (_) { return false; } }
const isInterviewed = (dir, c) => !!(c.interviewedAt || transcriptDone(dir, c.agentId));
function candState(dir, c) {
  if (isInterviewed(dir, c)) return 'interviewed';
  if (interviewRunning(dir, c)) return 'running';
  // started and still queued in its interview process (or between the spawn and its first answer): not due again yet
  const t = c.interviewStartedAt ? Date.parse(c.interviewStartedAt) : 0;
  if (t && Date.now() - t < 45 * 60e3 && !(c.interviewFailedAt && Date.parse(c.interviewFailedAt) >= t)) return 'running';
  if ((Number(c.interviewFailures) || 0) >= MAX_INTERVIEW_TRIES) return 'failed';
  return 'pending';
}
// who picks: the people function holder (the CEO while it holds people), with the role's manager when that is someone else
function pickSeats(round) {
  const mgr = (round && round.manager) || ceoId(), ppl = peopleId();
  return (!mgr || mgr === ceoId() || mgr === ppl) ? [ppl].filter(Boolean) : [...new Set([mgr, ppl].filter(Boolean))];
}
const lsMd = d => { try { return fs.readdirSync(d).filter(f => f.endsWith('.md')).sort(); } catch (_) { return []; } };
function roundFiles(dir) {
  return { spec: !!readIf(path.join(dir, 'role-spec.md')).trim(), questions: !!readIf(path.join(dir, 'interview.md')).trim(),
    profiles: lsMd(path.join(dir, 'profiles')), scorecard: !!readIf(path.join(dir, 'scorecard.md')).trim() };
}
// "# Candidate profile — Nadia Farrell" -> Nadia Farrell; a heading that names no one -> the file name
function profileName(file, txt) {
  const head = ((String(txt || '').match(/^#\s+(.+)$/m) || [])[1] || '').trim();
  let n = head.split(/\s+[—–-]\s+|:\s*/).pop().trim();
  if (!n || /\b(profile|candidate)\b/i.test(n)) n = path.basename(file, '.md').replace(/[-_]+/g, ' ');
  return n.replace(/[^A-Za-z' -]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
}
// optional "## Model" section in a profile: provider/model [effort]
function profileModel(txt) { const m = sec(txt, 'Model').match(/([a-z0-9-]+)\/([A-Za-z0-9._:-]+)(?:\s+(low|medium|high))?/); return m ? { provider: m[1], model: m[2], effort: m[3] || null } : null; }
const lastAt = list => list.filter(Boolean).sort().pop() || null;

/* the live stage of a round, for the console and the dispatcher: { key, label, at, waitingOn, counts, timeline } */
function roundStage(dir, round) {
  const cands = (round && round.candidates) || [];
  const active = cands.filter(c => c.status === 'candidate');
  const st = active.map(c => ({ c, s: candState(dir, c) }));
  const n = k => st.filter(x => x.s === k).length;
  const counts = { candidates: active.length, interviewed: n('interviewed'), running: n('running'), failed: n('failed'), pending: n('pending'), released: cands.filter(c => c.status === 'released').length };
  const seats = pickSeats(round), seatNames = seats.map(co.nameOf).join(' and ');
  const hiredC = round.hired ? cands.find(c => c.agentId === round.hired) : null;
  const tl = [{ step: 'opened', at: round.openedAt || null, by: round.openedBy || null }];
  if (cands.length) tl.push({ step: 'candidates created', at: lastAt(cands.map(c => c.createdAt)), n: cands.length });
  const started = lastAt(cands.map(c => c.interviewStartedAt));
  if (started) tl.push({ step: 'interviews started', at: cands.map(c => c.interviewStartedAt).filter(Boolean).sort()[0] });
  const allIn = active.length && !counts.running && !counts.pending && counts.interviewed >= 1;
  if (counts.interviewed || round.pick || round.hired) { const at = lastAt(cands.map(c => c.interviewedAt)); if (at) tl.push({ step: 'interviews ' + (allIn || round.pick || round.hired ? 'complete' : counts.interviewed + '/' + active.length), at }); }
  if (round.pickRequest) tl.push({ step: 'pick handed to ' + (round.pickRequest.seats || seats).map(co.nameOf).join(' and '), at: round.pickRequest.at });
  if (round.pick) tl.push({ step: 'picked ' + (round.pick.name || round.pick.agentId) + ' (' + round.pick.by + ')', at: round.pick.at });
  if (hiredC) tl.push({ step: 'hired', at: hiredC.hiredAt || null });
  const S = (key, label, at, waitingOn) => ({ key, label, at: at || null, waitingOn: waitingOn || null, counts, timeline: tl });
  if (hiredC) return S('hired', 'hired ' + (hiredC.officeName || hiredC.name), hiredC.hiredAt);
  if (round.hired) return S('hired', 'hired ' + round.hired, null);
  if (round.closed) return S('closed', 'closed' + (round.closedWhy ? ': ' + round.closedWhy : ''), round.closedAt);
  if (round.pick) {
    const p = round.pick, who = p.name || p.agentId;
    if (p.waitingOwner) return p.waitingOwner.denied || gov.approved('hiring:hire:' + round.slug + ':' + p.agentId) === false
      ? S('declined', 'picked ' + who + '; you declined the hire', p.waitingOwner.at, seats.join(','))
      : S('waiting-owner', 'picked ' + who + '; waiting for your approval', p.waitingOwner.at, 'owner');
    return S('picked', 'picked ' + who + '; hiring' + (p.lastError ? ' (last try failed: ' + String(p.lastError).slice(0, 80) + ')' : ''), p.at, 'hire.js');
  }
  const files = roundFiles(dir);
  if (allIn) return S('waiting-pick', 'waiting for pick by ' + seatNames, round.pickRequest ? round.pickRequest.at : lastAt(active.map(c => c.interviewedAt)), seats.join(','));
  if (counts.running || counts.interviewed) return S('interviewing', 'interviewing ' + counts.interviewed + '/' + active.length + (counts.failed ? ' (' + counts.failed + ' failed)' : ''), started, 'interviews');
  if (!active.length) {
    if (!files.spec || !files.profiles.length) return S('needs-files', 'waiting for the round files (' + [!files.spec && 'role-spec.md', !files.questions && 'interview.md', !files.profiles.length && 'profiles/'].filter(Boolean).join(', ') + ') from ' + co.nameOf(peopleId()), round.filesRequest ? round.filesRequest.at : round.openedAt, peopleId());
    return S('candidates', 'creating candidates', round.openedAt, 'hire.js');
  }
  if (!files.questions) return S('needs-files', active.length + ' candidates created; waiting for interview.md from ' + co.nameOf(peopleId()), lastAt(active.map(c => c.createdAt)), peopleId());
  if (counts.failed && !counts.pending) return S('interviews-failed', 'every interview failed ' + MAX_INTERVIEW_TRIES + ' times; needs ' + co.nameOf(peopleId()), lastAt(active.map(c => c.createdAt)), peopleId());
  return S('candidates', active.length + ' candidates created; interviews start now', lastAt(active.map(c => c.createdAt)), 'hire.js');
}

// what the pick seat reads: one row per candidate (transcript, answers, failures, length) and the rubric
function writeScorecardInputs(dir, round) {
  const active = (round.candidates || []).filter(c => c.status === 'candidate');
  const rows = active.map(c => {
    const tf = c.transcript ? path.resolve(ROOT, c.transcript) : path.join(dir, 'interviews', c.agentId + '.md');
    const t = readIf(tf, 1e7);
    const answers = (t.match(/^### Answer$/gm) || []).length, failed = (t.match(/^\*\*No answer:\*\*/gm) || []).length;
    const words = t.split(/^### Answer$/m).slice(1).map(x => x.split(/\n(?=_run |## |Finished )/)[0]).join(' ').split(/\s+/).filter(Boolean).length;
    return '| ' + c.name + ' | `' + c.agentId + '` | ' + c.provider + '/' + c.model + ' | ' + (t ? '`' + relp(tf) + '`' : 'no transcript' + (c.interviewError ? ' (' + c.interviewError.slice(0, 80) + ')' : '')) + ' | ' + answers + ' | ' + failed + ' | ' + words + ' |';
  });
  const card = readIf(path.join(dir, 'scorecard.md'), 20000).trim();
  const f = path.join(dir, 'scorecard-inputs.md');
  fs.writeFileSync(f, '# Scorecard inputs — ' + round.role + ' (' + round.slug + ')\n\nWritten by hire.js advance ' + stamp() + ' when every interview was in. The pick is a judgement by ' + pickSeats(round).map(co.nameOf).join(' and ') +
    (round.pickRule ? ', or the round\'s scorecard rule (round.json pickRule)' : '') + '; record it with `node company/tools/hire.js pick`.\n\n' +
    '| Candidate | Agent | Model | Transcript | Answers | No answer | Words |\n|---|---|---|---|---|---|---|\n' + rows.join('\n') + '\n\n' +
    '## Rubric\n\n' + (card ? 'From `company/hiring/' + round.slug + '/scorecard.md`: score each transcript there, line by line.\n' : 'No scorecard.md yet: score against the role spec (`role-spec.md`) and write the totals in your pick (`--why`).\n') +
    '\n## Recommendation\n\n_(the pick seat writes it: who, the totals per candidate, why)_\n');
  return relp(f);
}

function appendInbox(inbox, block) { fs.mkdirSync(HANDOFFS, { recursive: true }); const f = path.join(HANDOFFS, inbox); if (!fs.existsSync(f)) fs.writeFileSync(f, '# Handoffs\n'); fs.appendFileSync(f, block); }
function pickHandoff(round, seatId, inputs) {
  const day = stamp().slice(0, 10), seats = pickSeats(round), other = seats.filter(x => x !== seatId).map(co.nameOf);
  const level = (() => { try { return co.gate('hiring'); } catch (_) { return 'approve'; } })();
  const active = (round.candidates || []).filter(c => c.status === 'candidate');
  const follows = level === 'approve' ? 'the owner is then asked to approve it (hiring is "approve")' : 'the hire, desk, loop routine, inbox and the release of the others follow within seconds (hiring is "' + level + '"' + (level === 'notify' ? '; the owner is told' : '') + ')';
  return '\n## ' + day + ' from hire.js — pick the ' + round.role + ' (' + round.slug + '): every interview is in\n' +
    '**Need:** score the transcripts against `company/hiring/' + round.slug + '/scorecard.md`' + (other.length ? ' and agree the pick with ' + other.join(', ') : '') + ', then record it: `node company/tools/hire.js pick --round ' + round.slug + ' --agent <id> --by ' + co.nameOf(seatId) + ' --why "<totals and why>"`' +
    ' (add `--functions <list>` / `--template <seat>` / `--title "..."` if the round needs them). ' + follows + '. Do not run interviews yourself. If nobody clears the bar, release them with hire.js release and say so in the round log.\n' +
    '**Why:** the round is waiting only on this judgement.\n**Deadline:** ' + day + '\n**Status:** OPEN\n' +
    '**Evidence:** `' + inputs + '`; transcripts ' + active.map(c => (c.transcript ? '`' + c.transcript + '`' : c.agentId + ' (none)')).join(', ') + '\n' +
    '**Candidates:** ' + active.map(c => c.name + ' `' + c.agentId + '` on ' + c.provider + '/' + c.model).join('; ') + '\n' +
    '**Recommendation:** _(yours: who, the totals, why)_\n';
}
// the pick handoffs of a round, closed when the pick is recorded (Status DONE plus a Resolved line, as HANDOFFS.md asks)
function closePickHandoffs(round, note) {
  for (const id of new Set(((round.pickRequest || {}).seats || []).concat(pickSeats(round)))) {
    const f = path.join(HANDOFFS, inboxOf(id)); let t; try { t = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    const parts = t.split(/^(?=## )/m); let hit = false;
    for (let i = 0; i < parts.length; i++) {
      if (!/^## .* from hire\.js — pick the /.test(parts[i]) || !parts[i].includes('(' + round.slug + ')') || !/^\*\*Status:\*\*\s*OPEN\b/m.test(parts[i])) continue;
      parts[i] = parts[i].replace(/^\*\*Status:\*\*\s*OPEN.*$/m, '**Status:** DONE\n**Resolved ' + stamp().slice(0, 10) + ' by hire.js:** ' + note); hit = true;
    }
    if (hit) fs.writeFileSync(f, parts.join(''));
  }
}

// the round's own scorecard rule (round.json pickRule {type:"scores", file:"scores.json", min:3.5, setBy:"<decider>"}):
// scores.json { "<agentId or candidate name>": { total, mustHaveAvg?, mustHaveMin? } } -> the highest total that clears the bar
function rulePick(dir, round) {
  const rule = round.pickRule;
  if (!rule || rule.type !== 'scores') return null;
  if (!approverOk(rule.setBy, deciders(round.manager))) return { none: true, why: 'pickRule was set by ' + (rule.setBy || 'nobody') + ', who does not decide this round (' + deciders(round.manager).join(' or ') + ')' };
  const file = path.join(dir, String(rule.file || 'scores.json').replace(/[^A-Za-z0-9._-]/g, ''));
  const sc = readJson(file, null);
  if (!sc) return { none: true, why: 'no ' + relp(file) + ' yet', waiting: true };
  const min = Number.isFinite(Number(rule.min)) ? Number(rule.min) : 3.5;
  const table = sc.candidates || sc, byName = Object.fromEntries(Object.entries(table).map(([k, v]) => [String(k).toLowerCase(), v]));
  const rows = (round.candidates || []).filter(c => c.status === 'candidate' && isInterviewed(dir, c)).map(c => ({ c, s: table[c.agentId] || byName[String(c.name || '').toLowerCase()] || null }))
    .filter(x => x.s && Number.isFinite(Number(x.s.total)));
  const ok = rows.filter(x => (x.s.mustHaveAvg === undefined || Number(x.s.mustHaveAvg) >= min) && (x.s.mustHaveMin === undefined || Number(x.s.mustHaveMin) > 2));
  if (!ok.length) return { none: true, why: rows.length ? 'no candidate clears the rule (must-have average >= ' + min + ', no must-have at 2 or below)' : 'scores.json scores no interviewed candidate' };
  ok.sort((a, b) => Number(b.s.total) - Number(a.s.total));
  const w = ok[0];
  return { agentId: w.c.agentId, by: String(rule.setBy).match(/^[A-Za-z]+/)[0], why: 'scorecard rule (round.json pickRule, set by ' + rule.setBy + '): highest total ' + w.s.total + (w.s.mustHaveAvg !== undefined ? ', must-have average ' + w.s.mustHaveAvg : '') + ' (' + rows.map(x => x.c.name + ' ' + x.s.total).join(', ') + ')' };
}

// record a pick (validated: an interviewed active candidate, a seat that decides this round); returns the pick
function recordPick(dir, slug, p) {
  const round = readJson(path.join(dir, 'round.json'), null);
  if (!round) out(2, { ok: false, error: 'no round ' + slug });
  if (round.hired) out(2, { ok: false, error: 'round ' + slug + ' already hired ' + round.hired });
  if (round.pick && round.pick.agentId !== p.agentId && gov.approved('hiring:hire:' + slug + ':' + round.pick.agentId) !== false) out(2, { ok: false, error: 'round ' + slug + ' already has a pick (' + (round.pick.name || round.pick.agentId) + ' by ' + round.pick.by + ')' });
  const allowed = deciders(round.manager);
  if (!approverOk(p.by, allowed)) out(2, { ok: false, error: '--by must be who decides this round: ' + allowed.join(' or ') });
  const cand = (round.candidates || []).find(c => c.agentId === p.agentId && c.status === 'candidate');
  if (!cand) out(2, { ok: false, error: p.agentId + ' is not an active candidate in ' + slug + ' (one of: ' + (round.candidates || []).filter(c => c.status === 'candidate').map(c => c.agentId).join(', ') + ')' });
  if (!isInterviewed(dir, cand)) out(2, { ok: false, error: cand.name + ' has not finished the interview' });
  const at = new Date().toISOString();
  const pick = { agentId: p.agentId, name: cand.name, by: p.by, why: String(p.why || '').slice(0, 1000), at, via: p.via || 'hire.js pick',
    title: p.title || round.title || round.role, functions: p.functions || round.functions || null, template: p.template || round.template || null, access: p.access || null, officeName: p.name || null,
    approved: p.by + ', ' + (p.via || 'hire.js pick') + ' ' + stamp() + ' (company/hiring/' + slug + '/scorecard.md)' };
  mutateRound(dir, r => { r.pick = Object.assign({}, r.pick && r.pick.agentId === p.agentId ? r.pick : {}, pick); delete r.pick.waitingOwner; });
  const card = path.join(dir, 'scorecard.md');
  fs.appendFileSync(card, (fs.existsSync(card) ? '\n' : '# Scorecard — ' + round.role + '\n') + '\n## Pick ' + stamp() + '\n\n' + p.by + ' picked **' + cand.name + '** (`' + p.agentId + '`): ' + (pick.why || '(no reason given)') + '\n');
  const dec = co.p('company', 'work', 'decisions.md');
  try { if (!fs.existsSync(dec)) fs.writeFileSync(dec, '# Decisions\n\n'); fs.appendFileSync(dec, '- ' + stamp() + ' ' + p.by + ' picked **' + cand.name + '** as **' + pick.title + '** (round `' + slug + '`, ' + pick.via + '): ' + (pick.why || 'see the scorecard').replace(/\s+/g, ' ').slice(0, 400) + '\n'); } catch (_) {}
  logLine(dir, 'PICK ' + cand.name + ' (' + p.agentId + ') by ' + p.by + ' via ' + pick.via + ': ' + (pick.why || '').replace(/\s+/g, ' ').slice(0, 200));
  closePickHandoffs(round, p.by + ' picked ' + cand.name + ' (' + pick.via + ')');
  return pick;
}

// finish a recorded pick: hire (desk, loop routine with the company folder blessed + workbench grant + workdir, inbox,
// dossier, under the hiring governance level), release the others, give the new seat its first OPEN handoff so the
// dispatcher's inbox wake starts its first run in the same tick
async function finishHire(dir, slug) {
  let claimed = false;
  mutateRound(dir, r => { if (r.hired || !r.pick) return; const f = r.pick.finishingAt ? Date.parse(r.pick.finishingAt) : 0; if (Date.now() - f < FINISH_LEASE_MS) return; r.pick.finishingAt = new Date().toISOString(); claimed = true; });
  if (!claimed) return { ok: false, skipped: true, error: 'already hired, no pick, or another hire.js is finishing it' };
  const round = readJson(path.join(dir, 'round.json'), {}); const p = round.pick;
  const args = { round: slug, agent: p.agentId, title: p.title || round.role, by: p.by, approved: p.approved };
  if (p.functions) args.functions = String(p.functions);
  if (p.template) args.template = String(p.template);
  if (p.access) args.access = String(p.access);
  if (p.officeName) args.name = String(p.officeName);
  const r = await soft(() => hire(args));
  if (!r.ok) {
    const waiting = r.code === 3 && r.obj && r.obj.governance;
    mutateRound(dir, x => { if (!x.pick) return; delete x.pick.finishingAt;
      if (waiting) x.pick.waitingOwner = { at: (x.pick.waitingOwner && x.pick.waitingOwner.at) || new Date().toISOString(), questionId: r.obj.governance.questionId || null, denied: !!r.obj.governance.denied };
      else x.pick.lastError = r.error.slice(0, 300); });
    if (!waiting) logLine(dir, 'HIRE of ' + (p.name || p.agentId) + ' not finished: ' + r.error.slice(0, 200));
    return { ok: false, waitingOwner: !!waiting, questionId: waiting ? r.obj.governance.questionId || null : null, error: r.error };
  }
  mutateRound(dir, x => { if (x.pick) { delete x.pick.finishingAt; delete x.pick.waitingOwner; delete x.pick.lastError; x.pick.hiredAt = new Date().toISOString(); } });
  const h = r.value;
  const released = [];
  for (const c of (readJson(path.join(dir, 'round.json'), {}).candidates || []).filter(c => c.status === 'candidate' && c.agentId !== p.agentId)) {
    const rr = await soft(() => release({ round: slug, agent: c.agentId, reason: 'not picked: ' + p.by + ' picked ' + (p.name || p.agentId) + (p.why ? ' (' + p.why.slice(0, 160) + ')' : ''), by: p.by }));
    released.push(rr.ok ? c.agentId : c.agentId + ': ' + rr.error.slice(0, 120));
  }
  const row = co.crew()[p.agentId];
  if (row && row.inbox) appendInbox(row.inbox, '\n## ' + stamp().slice(0, 10) + ' from hire.js — your first session as ' + h.title + '\n**Need:** read your charter (`' + h.role + '`), company/HANDOFFS.md and company/CHAIN_OF_COMMAND.md; write a short first-week plan in your log and tell ' + (co.nameOf(round.manager || ceoId())) + ' in a handoff what you will deliver first. Close this handoff with the plan\'s path.\n**Why:** you were hired ' + stamp() + ' in round ' + slug + '; your first run starts now.\n**Deadline:** ' + stamp().slice(0, 10) + '\n**Status:** OPEN\n**Evidence:** `company/hiring/' + slug + '/hired.md`\n');
  return { ok: true, hired: h, released };
}

function openRounds() {
  let ds = []; try { ds = fs.readdirSync(HIRING); } catch (_) {}
  return ds.filter(d => ROUND_RE.test(d) && d !== 'former').map(d => ({ slug: d, round: readJson(path.join(HIRING, d, 'round.json'), null) }))
    .filter(x => x.round && !x.round.hired && !x.round.closed).map(x => x.slug).sort();
}

/* one round as far as it goes mechanically. o: { held (the metered cap holds metered work), dry, noInterviews, inline, parallel } */
async function advanceRound(slug, o) {
  o = o || {};
  const dir = path.join(HIRING, slug);
  const load = () => readJson(path.join(dir, 'round.json'), null);
  let round = load();
  if (!round) return { slug, ok: false, error: 'no round' };
  const did = [], notes = [];
  const res = () => { const r = load() || round; const s = roundStage(dir, r); return { slug, role: r.role, stage: s.key, label: s.label, at: s.at, counts: s.counts, pickSeats: pickSeats(r), pickRequestAt: r.pickRequest ? r.pickRequest.at : null, hired: r.hired || null, hiredNow: did.some(x => /^hired /.test(x)) ? r.hired : null, did, notes }; };
  if (round.hired || round.closed) return res();
  if (co.startsHeld()) { notes.push(co.halted() ? 'the company is halted (' + co.halted() + '): nothing advances' : 'a station restart is waiting for idle (restart hold): nothing advances until it is done'); return res(); }
  if (o.dry) { notes.push('dry run'); return res(); }
  const by = round.openedBy || co.nameOf(peopleId());
  // 1. a recorded pick: finish the hire
  if (round.pick) {
    const ans = round.pick.waitingOwner ? gov.approved('hiring:hire:' + slug + ':' + round.pick.agentId) : true;
    if (ans === null) { notes.push('waiting for the owner\'s answer'); return res(); }
    if (ans === false) { notes.push('the owner said no to this pick; the pick seat decides what next (release, or another pick)'); return res(); }
    const f = await finishHire(dir, slug);
    if (f.ok) did.push('hired ' + f.hired.name + ' as ' + f.hired.title + (f.released.length ? '; released ' + f.released.join(', ') : ''));
    else if (f.waitingOwner) did.push('asked the owner to approve the pick (question ' + (f.questionId || '?') + ')');
    else if (!f.skipped) notes.push('hire not finished: ' + f.error.slice(0, 200));
    return res();
  }
  let files = roundFiles(dir);
  let active = (round.candidates || []).filter(c => c.status === 'candidate');
  const allInNow = () => { const r = load(); const a = (r.candidates || []).filter(c => c.status === 'candidate'); return a.length && a.every(c => ['interviewed', 'failed'].includes(candState(dir, c))) && a.some(c => isInterviewed(dir, c)); };
  // 2. candidates from the profiles the people owner wrote (up to three active)
  if (files.spec && active.length < 3 && !allInNow()) {
    const used = new Set((round.candidates || []).map(c => c.profile && path.basename(c.profile)).filter(Boolean));
    for (const f of files.profiles.filter(f => !used.has(f)).slice(0, 3 - active.length)) {
      const rel = 'company/hiring/' + slug + '/profiles/' + f, txt = readIf(path.join(dir, 'profiles', f), 8000);
      const name = profileName(f, txt), m = profileModel(txt) || {};
      const r = await soft(() => createCandidate({ round: slug, name, profile: rel, by, provider: m.provider, model: m.model, effort: m.effort || undefined }));
      if (r.ok) did.push('created candidate ' + r.value.name + ' (' + r.value.agentId + ')'); else notes.push('candidate from ' + f + ' not created: ' + r.error.slice(0, 160));
    }
    round = load(); active = (round.candidates || []).filter(c => c.status === 'candidate');
  }
  // 3. interviews: every candidate still to interview, in parallel, in the background
  const pending = active.filter(c => candState(dir, c) === 'pending');
  if (pending.length && files.questions && !o.noInterviews) {
    if (o.held && !gov.guard('spendCap')) notes.push('the spendCap guardrail is off: interviews go ahead past the metered cap');
    if (o.held && gov.guard('spendCap')) notes.push('interviews held: the 24h metered cap is reached');
    else {
      const r = await soft(() => interview({ round: slug, questions: 'company/hiring/' + slug + '/interview.md', background: !o.inline, advance: true, parallel: o.parallel || INTERVIEW_PARALLEL, who: peopleId() }));
      if (r.ok) did.push((o.inline ? 'interviewed ' : 'started interviews for ') + pending.map(c => c.name).join(', ') + ' (' + Math.min(pending.length, Number(o.parallel) || INTERVIEW_PARALLEL) + ' at a time)');
      else notes.push('interviews not started: ' + r.error.slice(0, 200));
    }
  }
  round = load();
  // 4. every interview in: scorecard inputs, then the round's rule or the pick seat
  if (allInNow() && !round.pick) {
    const inputs = writeScorecardInputs(dir, round);
    const rule = rulePick(dir, round);
    if (rule && rule.agentId) {
      const r = await soft(() => recordPick(dir, slug, { agentId: rule.agentId, by: rule.by, why: rule.why, via: 'pickRule' }));
      if (r.ok) {
        did.push('picked ' + r.value.name + ' by the scorecard rule');
        const f = await finishHire(dir, slug);
        if (f.ok) did.push('hired ' + f.hired.name + ' as ' + f.hired.title + (f.released.length ? '; released ' + f.released.join(', ') : ''));
        else if (f.waitingOwner) did.push('asked the owner to approve the pick (question ' + (f.questionId || '?') + ')');
        else notes.push('hire not finished: ' + String(f.error).slice(0, 200));
        return res();
      }
      notes.push('rule pick not recorded: ' + r.error.slice(0, 160));
    } else if (rule && rule.none) notes.push('scorecard rule: ' + rule.why + (rule.waiting ? '' : '; the pick goes to the seat'));
    let claim = false;
    if (!(rule && rule.waiting)) mutateRound(dir, r => { if (!r.pickRequest && !r.pick) { r.pickRequest = { at: new Date().toISOString(), seats: pickSeats(r), inputs }; claim = true; } });
    if (claim) {
      round = load();
      for (const id of round.pickRequest.seats) appendInbox(inboxOf(id), pickHandoff(round, id, inputs));
      logLine(dir, 'PICK HANDED to ' + round.pickRequest.seats.map(co.nameOf).join(' and ') + ' (' + round.pickRequest.seats.map(inboxOf).join(', ') + '); scorecard inputs ' + inputs);
      did.push('handed the pick to ' + round.pickRequest.seats.map(co.nameOf).join(' and '));
    }
  }
  // 5. stuck on the people owner's files: tell them once
  const s = roundStage(dir, round);
  if (s.key === 'needs-files' && !round.filesRequest) {
    let claim = false;
    mutateRound(dir, r => { if (!r.filesRequest) { r.filesRequest = { at: new Date().toISOString(), seat: peopleId() }; claim = true; } });
    if (claim) {
      const day = stamp().slice(0, 10);
      appendInbox(fnInbox('people'), '\n## ' + day + ' from hire.js — write the files for the ' + round.role + ' round (' + slug + ')\n' +
        '**Need:** in company/hiring/' + slug + '/ write research.md, role-spec.md, model-fit.md, interview.md (one question per "## " heading), scorecard.md, and one profiles/<name>.md per candidate (up to three; the charter headings, optional "## Model" line `provider/model`). That is all: the round then advances on its own (candidates, parallel interviews, scorecard inputs) and the pick comes back to you as a handoff. Do not run interviews yourself.\n' +
        '**Why:** ' + s.label + '.\n**Deadline:** ' + day + '\n**Status:** OPEN\n**Evidence:** `company/hiring/' + slug + '/round.json`\n');
      did.push('asked ' + co.nameOf(peopleId()) + ' for the round files');
    }
  }
  return res();
}

async function advance(a) {
  const slugs = a.all || !(a._ || a.round) ? openRounds() : [String(a._ || a.round)];
  for (const s of slugs) roundDir(s);
  const rounds = [];
  for (const s of slugs) {
    const r = await soft(() => advanceRound(s, { held: !!a.held, dry: !!a.dry, inline: !!a.inline, parallel: Number(a.parallel) || INTERVIEW_PARALLEL }));
    rounds.push(r.ok ? r.value : { slug: s, ok: false, error: r.error });
  }
  return { ok: true, rounds };
}

// hire.js pick: the deciding seat's judgement, recorded; the hire follows at once under the hiring governance level
async function pickCmd(a) {
  const slug = need(a, 'round'); const { dir } = loadRound(slug);
  const pick = recordPick(dir, slug, { agentId: need(a, 'agent'), by: need(a, 'by'), why: need(a, 'why'), title: a.title && a.title !== true ? String(a.title) : null,
    functions: a.functions && a.functions !== true ? String(a.functions) : null, template: a.template && a.template !== true ? String(a.template) : null,
    access: a.access === 'ask' ? 'ask' : null, name: a.name && a.name !== true ? String(a.name) : null });
  const f = co.startsHeld() ? { ok: false, error: co.halted() ? 'the company is halted; the hire finishes on the first tick after resume' : 'a station restart is waiting for idle; the hire finishes on the first tick after it' } : await finishHire(dir, slug);
  return { ok: true, picked: pick.agentId, name: pick.name, hired: f.ok ? f.hired : null, released: f.released || [], waitingOwner: !!f.waitingOwner, questionId: f.questionId || null,
    note: f.ok ? 'hired; the new seat\'s first run starts on this dispatcher tick' : f.waitingOwner ? 'the pick is recorded; hiring is "approve", so the owner was asked; the hire finishes on the first tick after their yes' : 'the pick is recorded; ' + (f.error || 'the hire finishes on the next tick') };
}

function loopPrompt(id, c, roleFileBase) {
  const TOK = '$(cat secrets/station-token)';
  const URL0 = co.STATION_URL.replace(/\/$/, '');
  const POST = 'curl -s -H "x-starnet-token: ' + TOK + '" -H "Content-Type: application/json" -X POST ' + URL0;
  const ceo = ceoId();
  return 'You are ' + c.name + ', ' + c.title + ' at ' + companyName() + ', an AI-run company owned by ' + ownerName() + ' (the owner). This is your work session and nobody is watching, so decide and act within your scope. Your working folder is the company root (' + ROOT + ') and you have a terminal; use it.\n\n' +
    'Start by reading company/roles/' + roleFileBase + '.md (your charter), company/HANDOFFS.md, company/DECISION_RIGHTS.md and company/CHAIN_OF_COMMAND.md.\n\n' +
    'WORK THE QUEUE. Keep taking items until your queue is empty or everything left is blocked on someone else. Do not stop after one item.\nYour queue, in this order:\n' +
    ' 1. OPEN handoffs in company/work/handoffs/' + c.inbox + ': deadline today first, then oldest first.\n' +
    ' 2. Unticked steps of open station quests you own or that name you: curl -s -H "x-starnet-token: ' + TOK + '" ' + URL0 + '/api/quests\n' +
    ' 3. Open items in company/work/improvements.md that fall inside your scope.\nFor each item:\n' +
    ' a. Do it end to end with real commands, then verify with evidence. If it fails twice, write down why and move on.\n' +
    ' b. Close it where it lives: a handoff gets its own **Status:** line changed to DONE plus a **Resolved <date> by ' + c.name + ':** line; a quest step: ' + POST + '/api/quests/update -d \'{"id":"q:N","op":"tick","stepKey":"<key>","note":"<evidence>"}\'\n' +
    ' c. If the next step belongs to someone else, write that handoff now (company/work/handoffs/to-<name>.md).\n' +
    ' d. Append a dated entry to company/work/' + c.log + '.\n' +
    'QUESTS CLOSE ON EVIDENCE. When every step of a quest you own is ticked, attest it: ' + POST + '/api/quests/update -d \'{"id":"q:N","op":"attest","agentId":"' + id + '","evidence":"<cite every file path in backticks>"}\'. For new multi-step work, mint a quest whose contract is the deliverable file: ' + POST + '/api/quests/mint -d \'{"title":"<title> -> company/work/<path>","agentId":"' + id + '","kind":"work","domain":"<one of the eight below>","contract":{"type":"artifact","key":"company/work/<path>"},"steps":[{"key":"<k>","label":"<label>"}]}\'. EVERY mint needs a "domain" from StarNet\'s set (building, research, writing, growth, operations, creative, planning, support): a quest without one earns no mastery credit, and credit for a closed quest can never be added later. Pick the one the work is: code, tests or station infra = building; running the company (finance, people, security, facilities) = operations; a lead list or outreach = growth; a spec or a plan = planning; a design or a visual asset = creative; an investigation = research; a written explainer = writing; helping a person adopt a tool = support.\n' +
    'Stop when the queue is empty, when everything left is blocked, or after about six items. Finish with three short lines: done, handed off, blocked.\n' +
    'OWNER GATES (money beyond the cap, credentials or access, ownership, a public commitment) go up your chain of command (company/CHAIN_OF_COMMAND.md) as a handoff, ending with the CEO, ' + co.nameOf(ceo) + ', in company/work/handoffs/' + inboxOf(ceo) + '. Never message the owner yourself and never file company/inbox.js questions.\n' +
    'READ RULE: never guess file paths; list a folder first.\n' +
    require('./founder-loop.js').HIRING_LINE;
}

// Replace one "## <heading>" section of a charter with new body text (the heading line is kept), or append it.
function setSection(txt, heading, body) {
  const re = new RegExp('(^## ' + heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^\\n]*\\n)([\\s\\S]*?)(?=^## |(?![\\s\\S]))', 'm');
  if (re.test(txt)) return txt.replace(re, (m, h) => h + body.trim() + '\n\n');
  return txt.trimEnd() + '\n\n## ' + heading + '\n' + body.trim() + '\n';
}
// --functions people,tools: the new seat takes these utility functions; whoever held them (normally the founder) drops
// them. Returns { take, from: { id: [fn] } } and mutates loops in place. The ceo function never moves through hire.js.
function moveFunctions(loops, newId, list) {
  const take = [...new Set(String(list || '').split(/[\s,]+/).map(x => x.trim().toLowerCase()).filter(Boolean))];
  const bad = take.filter(f => !FUNCTIONS.includes(f) || f === 'ceo');
  if (bad.length) return { error: '--functions takes ' + FUNCTIONS.filter(f => f !== 'ceo').join(', ') + '; not ' + bad.join(', ') + ' (the ceo function is the owner\'s call)' };
  const from = {};
  const LEGACY = { people: 'hr', tools: 'toolsOwner' };
  for (const [id, seat] of Object.entries(loops.agents || {})) {
    if (!seat || id === newId) continue;
    for (const f of take) {
      let had = false;
      if (Array.isArray(seat.functions) && seat.functions.includes(f)) { seat.functions = seat.functions.filter(x => x !== f); had = true; }
      if (LEGACY[f] && seat[LEGACY[f]]) { delete seat[LEGACY[f]]; had = true; }
      if (had) (from[id] = from[id] || []).push(f);
    }
  }
  const row = loops.agents[newId];
  if (row) row.functions = [...new Set((Array.isArray(row.functions) ? row.functions : []).concat(take))];
  return { take, from };
}

/* Separation of duties. A pack's or module's seats[] may say `independentOf: [...]`: names of other seats in the same
 * pack/module, or functions (ceo, people, tools, risk, floor, finance). One agent may never hold a seat and anything on
 * its independentOf list (the seat that reconciles is never the seat that trades). Seats are keyed as hire.js
 * --template sees them: <pack>--<seat>. Rules come from installed packs (company/state/packs/installed/<id>/pack.json)
 * and modules (modules/<id>/module.json). */
function independenceRules(root) {
  const r = root || ROOT; const rules = {};
  const add = (id, j) => { for (const s of (j && j.seats) || []) if (s && s.name && Array.isArray(s.independentOf) && s.independentOf.length)
    rules[id + '--' + s.name] = s.independentOf.map(x => (FUNCTIONS.includes(x) || String(x).includes('--') ? String(x) : id + '--' + x)); };
  const ls = d => { try { return fs.readdirSync(d); } catch (_) { return []; } };
  for (const id of ls(path.join(r, 'company', 'state', 'packs', 'installed'))) add(id, readJson(path.join(r, 'company', 'state', 'packs', 'installed', id, 'pack.json'), null));
  for (const id of ls(path.join(r, 'modules'))) add(id, readJson(path.join(r, 'modules', id, 'module.json'), null));
  return rules;
}
// holdings = { seats: ['<pack>--<seat>'], functions: ['finance', ...] } -> list of conflicts (empty = fine)
function independenceConflicts(holdings, rules) {
  const held = new Set([].concat(holdings.seats || [], holdings.functions || []).map(String));
  const out = [];
  for (const seat of holdings.seats || []) for (const x of (rules[seat] || [])) if (held.has(x)) out.push(seat + ' must be independent of ' + x + ', and this hire would hold both');
  return out;
}

async function hire(a) {
  const { dir, round } = loadRound(need(a, 'round'));
  const agentId = need(a, 'agent'), title = need(a, 'title'), by = need(a, 'by');
  // the pick is decided by the role's manager with the people owner (the people owner alone when the manager is the CEO)
  const approved = need(a, 'approved');
  { const allowed = deciders(round.manager); if (!approverOk(approved, allowed)) out(2, { ok: false, error: '--approved must start with who decided: ' + allowed.join(' or ') + ' (then where and when, e.g. "' + allowed[0] + ', decisions.md ' + stamp() + '")' }); }
  const cand = (round.candidates || []).find(c => c.agentId === agentId && c.status === 'candidate');
  if (!cand) out(2, { ok: false, error: agentId + ' is not an active candidate in this round' });
  { const bad = policyCheck(cand.provider, cand.model); if (bad) out(2, { ok: false, error: bad + ' (release this candidate; hire only on an allowed model)' }); }
  if (!cand.interviewedAt) {
    // a finished transcript is the proof (round.json can miss the mark when two interview processes raced)
    const tf = path.join(dir, 'interviews', agentId + '.md');
    if (/^Finished /m.test(readIf(tf, 1e7))) { cand.interviewedAt = new Date(fs.statSync(tf).mtimeMs).toISOString(); cand.transcript = path.relative(ROOT, tf); }
    else out(2, { ok: false, error: 'interview ' + agentId + ' before hiring' });
  }
  if (!readIf(path.join(dir, 'scorecard.md')).trim()) out(2, { ok: false, error: 'write the scorecard (company/hiring/' + round.slug + '/scorecard.md) before hiring' });
  const access = a.access === 'ask' ? 'ask' : 'full';
  mustGovern('hiring', Object.assign({ by, ref: 'hiring:hire:' + round.slug + ':' + agentId }, ASKS.hire({ name: cand.name, title, provider: cand.provider, model: cand.model, round: round.slug, agentId, approved })));
  // validate --functions and --template before anything is changed on the station
  if (a.functions && a.functions !== true) { const t = moveFunctions({ agents: {} }, agentId, a.functions); if (t.error) out(2, { ok: false, error: t.error }); }
  else if (a.functions === true) out(2, { ok: false, error: '--functions needs a list, e.g. --functions people,tools' });
  let templateTxt = '';
  if (a.template) {
    const t = String(a.template).replace(/\.md$/, '');
    if (a.template === true || !/^[a-z0-9][a-z0-9_-]*$/i.test(t)) out(2, { ok: false, error: '--template takes a seat template name from company/roles/templates/, e.g. tool-builder' });
    templateTxt = readIf(path.join(TEMPLATES, t + '.md'), 60000);
    if (!templateTxt.trim()) out(2, { ok: false, error: 'no seat template at ' + path.relative(ROOT, path.join(TEMPLATES, t + '.md')) });
  }
  // separation of duties (pack/module seats[].independentOf): the hire may not hold a seat and something it must stay independent of
  { const clash = independenceConflicts({ seats: a.template ? [String(a.template).replace(/\.md$/, '')] : [], functions: a.functions && a.functions !== true ? String(a.functions).split(/[\s,]+/).filter(Boolean) : [] }, independenceRules());
    if (clash.length) out(2, { ok: false, error: 'separation of duties: ' + clash.join('; ') + ' (independentOf in the pack or module seats; hire someone else for one of them)' }); }
  const spec = readIf(path.join(dir, 'role-spec.md'), 6000);
  const AgentId = require(path.join(ROOT, 'starnet', 'frontend', 'app', 'agentid.js'));
  const officeName = a.name ? AgentId.normalizeName(String(a.name)) : cand.name;
  const display = officeName.split(/(\s+|-)/).map(w => /^[A-Za-z]/.test(w) ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w).join('');   // NADIA FARRELL -> Nadia Farrell
  const fileBase = display.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const inbox = 'to-' + fileBase + '.md';
  const loopName = display + ' loop';
  const mgrId = round.manager || ceoId();
  const crewRow = { name: display, title, manager: mgrId, loop: loopName, inbox, log: 'agents/' + fileBase + ' loop.md', role: 'company/roles/' + fileBase + '.md', hiredIn: round.slug };
  if (a.template) crewRow.seat = String(a.template).replace(/\.md$/, '');
  const roleFile = path.join(ROLES, fileBase + '.md');
  if (!fs.existsSync(roleFile)) {
    const prof = cand.profile ? readIf(path.resolve(ROOT, cand.profile), 8000) : '';
    const research = readIf(path.join(dir, 'research.md'), 8000);
    const srcs = (research.match(/https?:\/\/\S+/g) || []).slice(0, 8).map((u, i) => (i + 1) + '. ' + u.replace(/[)>\].,]+$/, '')).join('\n');
    const mgrName = nameOf(mgrId) || 'the CEO';
    const reportsTo = mgrName + (mgrId === ceoId() ? ' (CEO)' : '');
    const scoped = stamp().slice(0, 10) + ' by ' + by + ' in hiring round ' + round.slug + ' (company/hiring/' + round.slug + '/)';
    const loopBody = 'The "' + loopName + '" routine; the dispatcher also wakes you when ' + inbox + ' has an OPEN handoff.';
    const handoffBody = '- Read company/work/handoffs/' + inbox + ' at the start of every session.\n- Owner gates go up your chain of command to the CEO; never message the owner yourself.';
    let txt;
    if (templateTxt) {
      // a seat template is the starting charter: fill its name/title placeholders, its header lines, and the sections
      // the candidate's profile and the round supply; the rest of the template stays as written
      txt = templateTxt.replace(/<!--[\s\S]*?-->\n?/g, '').replace(/<Name>/g, display).replace(/<Title>/g, title).replace(/<name>/g, fileBase);
      txt = /^\*\*Reports to:\*\*.*$/m.test(txt) ? txt.replace(/^\*\*Reports to:\*\*.*$/m, '**Reports to:** ' + reportsTo) : txt.replace(/^(# .*\n)/, '$1\n**Reports to:** ' + reportsTo + '\n');
      txt = /^\*\*Last scoped:\*\*.*$/m.test(txt) ? txt.replace(/^\*\*Last scoped:\*\*.*$/m, '**Last scoped:** ' + scoped) : txt.replace(/^(\*\*Reports to:\*\*.*\n)/m, '$1**Last scoped:** ' + scoped + '\n');
      if (!/^# /.test(txt)) txt = '# ' + display + ' — ' + title + '\n\n' + txt;
      for (const h of ['Personality', 'Backstory and motivation', 'Voice', 'Persona preset']) if (sec(prof, h)) txt = setSection(txt, h, sec(prof, h));
      txt = setSection(txt, 'Your autonomous loop', loopBody);
      txt = setSection(txt, 'Handoffs', handoffBody);
      txt = setSection(txt, 'Role spec from hiring round ' + round.slug, spec.replace(/^# .*\n/, '').trim() || '(no role spec)');
      if (srcs && !/https?:\/\//.test(sec(txt, 'Sources'))) txt = setSection(txt, 'Sources', srcs);
    } else {
      const keep = h => sec(prof, h) ? '## ' + h + '\n' + sec(prof, h) + '\n\n' : '';
      txt = '# ' + display + ' — ' + title + '\n\n**Reports to:** ' + reportsTo + '\n**Last scoped:** ' + scoped + '\n\n' +
        spec.replace(/^# .*\n/, '') + '\n\n' + keep('Personality') + keep('Backstory and motivation') + keep('Voice') + keep('Persona preset') +
        '## Your autonomous loop\n' + loopBody + '\n\n## Handoffs\n' + handoffBody + '\n\n' +
        (/^## Sources/m.test(spec) ? '' : '## Sources\n' + (srcs || 'company/hiring/' + round.slug + '/research.md') + '\n');
    }
    fs.mkdirSync(ROLES, { recursive: true });
    fs.writeFileSync(roleFile, txt);
  }
  fs.mkdirSync(HANDOFFS, { recursive: true });
  const inboxFile = path.join(HANDOFFS, inbox);
  if (!fs.existsSync(inboxFile)) fs.writeFileSync(inboxFile, '# Handoffs to ' + display + '\n\n_Format: see `company/HANDOFFS.md`._\n');
  let desk = null;
  await C.editSave(doc => {
    const rec = (doc.agents || []).find(x => x.id === agentId);
    if (!rec) return false;
    rec.name = officeName;
    rec.approvalMode = access;
    rec.provider = cand.provider; rec.model = cand.model; rec.reasoningEffort = cand.effort || rec.reasoningEffort || null;   // a hire keeps the model they interviewed on
    rec.purpose = (display + ', ' + title + ' at ' + companyName() + '. Charter: company/roles/' + fileBase + '.md').slice(0, 2000);
    rec.docs = Object.assign({}, rec.docs || {}, {
      identity: 'You are ' + officeName + ', ' + title + ' at ' + companyName() + ', an AI-run company owned by ' + ownerName() + '. ' + ceoName() + ' is the CEO' + (mgrId === ceoId() ? ' and your manager' : '; your manager is ' + (nameOf(mgrId) || mgrId)) + '. You were hired on ' + stamp().slice(0, 10) + ' after an interview round run by ' + by + ' (company/hiring/' + round.slug + '/). You work from a workstation on the company\'s StarNet station, with real tools. Use them, verify what you claim, and never claim work you have not checked.',
      purpose: 'You are ' + display + ', ' + title + '. Your charter is company/roles/' + fileBase + '.md and your inbox is company/work/handoffs/' + inbox + '.\n\n' + spec.slice(0, 4000),
    });
    // fill the whole dossier (identity, purpose, context, operating manual) from the new charter, like every crew member
    try { const D = require('./dossier.js'); const built = D.build(agentId, crewRow, rec); rec.docs = Object.assign({}, rec.docs || {}, built); rec.purpose = built.purpose.slice(0, 2000); } catch (e) { console.error('dossier build failed: ' + e.message); }
    const M = C.appModules();
    // Leave a gap in the prop-id counter: a station page that is open and behind keeps its own counter, and without
    // the gap its next prop could take this desk's id.
    if (doc.station && Number.isFinite(Number(doc.station._nid))) doc.station._nid = Number(doc.station._nid) + 50;
    const st = M.WorldModel.deserialize(doc.station);
    desk = st.ensureWorkstation(agentId);
    if (desk && desk.ok) doc.station = st.serialize();
  }, 'hire-onboard');
  const { doc } = await C.getSave();
  const { system } = C.compose(doc, agentId);
  const rows = C.rosterRows().map(r => r.agentId === agentId ? Object.assign({}, r, { system, name: officeName, role: title, approvalMode: access, provider: cand.provider, model: cand.model, reasoningEffort: cand.effort || r.reasoningEffort || null }) : r);
  const rr = await C.call('POST', '/api/roster', { agents: rows, updatedAt: Date.now() });
  if (rr.status !== 200 || !/"ok":true/.test(rr.body)) throw new Error('roster push failed: ' + rr.body.slice(0, 200));
  // approval mode rides the roster row and the save row above; /api/agent/approval is a best-effort echo (a page may answer it)
  try { await C.call('POST', '/api/agent/approval', { agentId, mode: access }); } catch (_) {}
  // register with the dispatcher, then create the loop routine
  const loops = readJson(LOOPS, { agents: {} }); loops.agents = loops.agents || {}; loops.agents[agentId] = crewRow;
  let moved = null;
  if (a.functions && a.functions !== true) moved = moveFunctions(loops, agentId, a.functions);
  writeJson(LOOPS, loops);
  if (moved && moved.take.length) {
    const fromTxt = Object.entries(moved.from).map(([id, fs_]) => (nameOf(id) || id) + ': ' + fs_.join(', ')).join('; ') || 'nobody held them';
    staffLog('FUNCTIONS ' + moved.take.join(', ') + ' moved to ' + display + ' (' + agentId + ') from ' + fromTxt + ' by ' + by + ' (approved: ' + approved + ')');
  }
  const prompt = loopPrompt(agentId, crewRow, fileBase);
  // A loop the station confines to the agent's own empty workspace can do nothing: the company folder must be a blessed
  // project and the routine needs the terminal grant (founder-loop.js, the same rule for every seat's loop).
  const FL = require('./founder-loop.js');
  const blessed = await FL.blessRoot(async (m, p, b) => { const r = await C.call(m, p, b); let j = null; try { j = JSON.parse(r.body); } catch (_) {} return { status: r.status, json: j, text: String(r.body || '').slice(0, 200) }; });
  if (!blessed.ok) staffLog('BLESS FAILED for the company folder while hiring ' + display + ': ' + blessed.error);
  // runtime.scheduler=dispatcher (lib/scheduler.js): the loop is created paused on the station and recorded as the
  // dispatcher's, which starts its scheduled runs; station: armed on the station's schedule, as before
  const SCHED = require('./lib/scheduler'); const dispatcherOwns = SCHED.mode() === 'dispatcher';
  // a 200 can be a decline (lib/station.js): the loop counts as created only when GET /api/cron lists it
  const made = await require('./lib/station').createRoutine((m, p, b) => C.call(m, p, b), { name: loopName, agentId, schedule: String(a.schedule || '0 */2 * * *'), tz: co.TZ, prompt,
    workdir: ROOT, deliver: 'local', enabled: !dispatcherOwns, model: cand.model, provider: cand.provider, unattendedGrants: FL.LOOP_GRANTS }, { what: 'loop "' + loopName + '"' });
  const jj = made.ok ? { ok: true, job: made.job } : { ok: false };
  const job = { body: made.reason };
  if (!made.ok) staffLog('LOOP NOT CREATED for ' + display + ': ' + made.reason);
  if (dispatcherOwns && jj.job && jj.job.id) { try { const st = SCHED.readState(ROOT); st.owned[jj.job.id] = { seat: agentId, name: loopName, on: true }; SCHED.writeState(Object.assign(st, { mode: 'dispatcher' }), ROOT); } catch (e) { staffLog('SCHEDULER: could not record ' + loopName + ' as the dispatcher\'s: ' + e.message); } }
  // the hire's own model chain (company/tools/models.js): the interviewed model first, then candidateDefault, then a
  // subscription model when one is connected on the station; the failover tick moves the seat along it
  let chain = null;
  try {
    const MD = require('./models.js');
    let pv = null; try { pv = JSON.parse((await C.call('GET', '/api/providers')).body).providers || null; } catch (_) {}
    chain = MD.hireChain({ provider: cand.provider, model: cand.model, effort: cand.effort || undefined }, pv, modelPolicy());
    if (!MD.recordHireChain(agentId, chain, by)) chain = null;
  } catch (e) { staffLog('MODEL CHAIN not recorded for ' + display + ': ' + String(e.message).slice(0, 160)); }
  // everyone's prompt carries the crew line, so recompose them all
  const synced = [];
  // With a station page open the page recomposes prompts itself and this push is ignored; that is reported, not fatal.
  const candidates = new Set((round.candidates || []).filter(c => c.status === 'candidate' && c.agentId !== agentId).map(c => c.agentId));
  for (const id of C.rows(doc).keys()) { if (candidates.has(id)) continue; try { synced.push((await C.syncPrompt(id)).agentId); } catch (e) { synced.push(id + ': ' + e.message.slice(0, 80)); } }
  const pageOpen = synced.some(x => /via:page/.test(String(x)));
  const reloaded = pageOpen ? await C.reloadStationPage() : null;
  mutateRound(dir, r => { const c = (r.candidates || []).find(x => x.agentId === agentId); if (c) Object.assign(c, { status: 'hired', hiredAt: new Date().toISOString(), hiredBy: by, approved, title, officeName, interviewedAt: c.interviewedAt || cand.interviewedAt, transcript: c.transcript || cand.transcript }); r.hired = agentId; });
  logLine(dir, 'HIRED ' + officeName + ' (' + agentId + ') as ' + title + ' by ' + by + ' (approved: ' + approved + '); access ' + access + '; desk ' + (desk && desk.ok ? desk.roomId : 'none') + '; loop "' + loopName + '" ' + (jj.ok ? 'created' : 'NOT created: ' + job.body.slice(0, 120)) + (moved && moved.take.length ? '; functions ' + moved.take.join(', ') : ''));
  fs.writeFileSync(path.join(dir, 'hired.md'), '# Hired: ' + officeName + ', ' + title + '\n\n- Agent: ' + agentId + ' on ' + cand.provider + '/' + cand.model + '\n- Hired ' + stamp() + ' by ' + by + '; approved: ' + approved + '\n- Access: ' + access + '; loop routine "' + loopName + '"; inbox company/work/handoffs/' + inbox + '; charter company/roles/' + fileBase + '.md\n- Transcript: ' + (cand.transcript || '') + '; scorecard: company/hiring/' + round.slug + '/scorecard.md\n');
  // The new desk, checked the way the floor owner's audit checks every desk (station-floor.js checkDesk: a free seat row,
  // one desk, the department's room). ensureWorkstation seats every hire in the spawn room and checks only that desk's
  // own seat, so a problem goes to the floor owner as an OPEN handoff, which wakes their loop; they fix it headlessly
  // with station-floor.js.
  let deskCheck;
  try { const F = require('./station-floor.js'); deskCheck = F.checkDesk(F.env(doc).WorldModel.deserialize(doc.station), agentId, { rows: C.rows(doc), name: display, title }); }
  catch (e) { deskCheck = { ok: false, desk: null, problems: [{ code: 'CHECK_FAILED', msg: 'The desk check could not run (' + String(e.message).slice(0, 160) + '); run `node company/tools/station-floor.js audit`.' }] }; }
  fs.appendFileSync(path.join(HANDOFFS, fnInbox('floor')), deskHandoff(deskCheck, { title, display, roomId: desk && desk.roomId, slug: round.slug }));
  return { ok: true, agentId, name: officeName, title, access, modelChain: chain ? chain.map(e => e.provider + '/' + e.model) : null, desk: desk && desk.ok ? desk.roomId : null, deskCheck: deskCheck.ok ? 'ok' : deskCheck.problems.map(p => p.code).join(','), loop: jj.ok ? (jj.job && jj.job.id) : ('failed: ' + job.body.slice(0, 160)), role: path.relative(ROOT, roleFile), inbox: path.relative(ROOT, inboxFile), functions: moved ? moved.take : [], functionsFrom: moved ? moved.from : {},
    stationPage: pageOpen ? (reloaded === 'reloaded' ? 'was open; reloaded so it shows the hire' : reloaded === 'busy' ? 'is open with a conversation in progress; it shows the hire after its next reload' : 'is open and could not be reloaded') : 'closed; prompts updated directly', promptsSynced: synced.filter(x => !/via:page/.test(String(x))) };
}

// The floor owner's handoff about a new hire's desk: the FYI (Status DONE, wakes nobody) when checkDesk found nothing,
// else an OPEN handoff with the problem and the station-floor.js command that fixes it (OPEN wakes their loop).
function deskHandoff(check, h) {
  const day = stamp().slice(0, 10), evidence = 'company/hiring/' + h.slug + '/hired.md';
  if (check && check.ok) return '\n## ' + day + ' from hire.js — FYI: new ' + h.title + ' ' + h.display + ' has a desk in ' + (h.roomId || 'no room') + '\n**Need:** record the seat in company/FLOOR_PLAN.md next time you update it. A station page that was open during the hire shows the new body and desk after a reload.\n**Why:** new hire.\n**Deadline:** none\n**Status:** DONE — FYI\n**Evidence:** ' + evidence + '\n';
  const probs = ((check && check.problems) || []).map(p => String(p.msg).replace(/\s+/g, ' ').trim()), codes = ((check && check.problems) || []).map(p => p.code).join(', ');
  const d = check && check.desk, where = d ? 'desk ' + d.id + ' at (' + d.x + ',' + d.y + ') in ' + d.room : 'no desk';
  const fix = check && check.suggest ? 'for example `' + check.suggest.command + '` (a free spot in ' + check.suggest.room + '; run it with --dry first)' : 'plan the move with `node company/tools/station-floor.js plan` or a `move <desk> <x> <y> --dry`';
  return '\n## ' + day + ' from hire.js — seat the new ' + h.title + ' ' + h.display + ' (' + codes + ')\n' +
    '**Need:** ' + probs.join(' ') + ' Fix it on the floor with `node company/tools/station-floor.js` (no page needed): ' + fix + '. Then run `node company/tools/station-floor.js doc` and write ' + h.display + '\'s Department and Justification in company/FLOOR_PLAN.md section 2. Done when `node company/tools/station-floor.js audit` passes A3, A4 and A8.\n' +
    '**Why:** hire.js seats every new hire with StarNet\'s ensureWorkstation, which uses the spawn room (HOME) and checks only that desk\'s own seat; where people sit is yours.\n' +
    '**Deadline:** ' + day + '\n**Status:** OPEN\n**Evidence:** ' + evidence + '; ' + where + '; checkDesk: ' + codes + '\n';
}

// REMODEL: same person, same charter, a different allowed model (the people owner or the person's manager decides; company/MODEL_POLICY.md)
async function remodel(a) {
  const agentId = need(a, 'agent'), provider = need(a, 'provider'), model = need(a, 'model'), by = need(a, 'by');
  if (agentId === ceoId()) out(2, { ok: false, error: 'the CEO\'s model is the owner\'s call' });
  const crew = co.crew();
  if (!crew[agentId]) out(2, { ok: false, error: agentId + ' is not on the crew (company/tools/loops.json)' });
  const approved = need(a, 'approved');
  { const allowed = deciders(crew[agentId].manager); if (!approverOk(approved, allowed)) out(2, { ok: false, error: '--approved must start with who decided: ' + allowed.join(' or ') }); }
  { const needCeo = (modelPolicy().needsCeoApproval || []).map(String);
    const ceoN = String(ceoName() || '').toLowerCase();
    if (needCeo.some(m => m === model || m === provider + '/' + model) && !(ceoN && String(approved).toLowerCase().split(/[^a-z0-9]+/).includes(ceoN)))
      out(2, { ok: false, error: 'a move to ' + model + ' also needs the CEO (' + ceoName() + '): say where they approved it in --approved' }); }
  const bad = policyCheck(provider, model); if (bad) out(2, { ok: false, error: bad });
  const effort = a.effort && a.effort !== true ? String(a.effort) : 'high';
  mustGovern('models', Object.assign({ by, ref: 'models:remodel:' + agentId + ':' + provider + '/' + model }, ASKS.remodel({ name: crew[agentId].name, agentId, provider, model, reason: a.reason, approved })));
  let before = null, prevRow = null;
  await C.editSave(doc => {
    let hit = false;
    for (const r of [doc.agent].concat(doc.agents || []).filter(x => x && x.id === agentId)) { before = before || (r.provider + '/' + r.model); prevRow = prevRow || { provider: r.provider, model: r.model, reasoningEffort: r.reasoningEffort }; r.provider = provider; r.model = model; r.reasoningEffort = effort; hit = true; }
    if (!hit) return false;
  }, 'remodel');
  const m = await C.call('POST', '/api/agent/model', { agentId, model, provider, effort });
  const mj = (() => { try { return JSON.parse(m.body); } catch (_) { return {}; } })();
  if (!(m.status === 200 && mj.ok === true)) {   // refused: put the save back so save, roster and routines stay on one model
    if (prevRow) await C.editSave(doc => { for (const r of [doc.agent].concat(doc.agents || []).filter(x => x && x.id === agentId)) Object.assign(r, prevRow); }, 'remodel-revert');
    staffLog('REMODEL REFUSED ' + crew[agentId].name + ' (' + agentId + ') to ' + provider + '/' + model + ': HTTP ' + m.status + ' ' + m.body.slice(0, 160));
    out(1, { ok: false, error: 'the station refused the model change: HTTP ' + m.status + ' ' + m.body.slice(0, 200) });
  }
  const jobs = (JSON.parse((await C.call('GET', '/api/cron')).body).jobs || []).filter(j => j.agentId === agentId);
  for (const j of jobs) { const u = await require('./lib/station').cron(C.call, 'POST', '/api/cron/update', { id: j.id, patch: { model, provider } }, 'move routine "' + j.name + '" to ' + provider + '/' + model); if (!u.ok) staffLog('REMODEL ROUTINE NOT MOVED ' + crew[agentId].name + ' (' + agentId + '): ' + u.reason); }
  // a seat with its own model chain keeps it, with the new model as its primary (company/tools/models.js)
  try { require('./models.js').putPrimary(agentId, { provider, model, effort }, by); } catch (_) {}
  const page = mj.via === 'page' ? await C.reloadStationPage() : 'closed';
  staffLog('REMODEL ' + crew[agentId].name + ' (' + agentId + '): ' + before + ' -> ' + provider + '/' + model + ' by ' + by + ' (approved: ' + approved + ')' + (a.reason ? ': ' + String(a.reason).slice(0, 200) : ''));
  return { ok: true, agentId, from: before, to: provider + '/' + model, routines: jobs.map(j => j.name), via: mj.via || null, stationPage: page };
}

// FIRE: remove a crew member (not the CEO), hand their open work to their manager, keep their charter for the replacement round
async function fire(a) {
  const agentId = need(a, 'agent'), reason = need(a, 'reason'), by = need(a, 'by');
  if (agentId === ceoId()) out(2, { ok: false, error: 'replacing the CEO is the owner\'s call, not a hire.js action' });
  const loops = readJson(LOOPS, { agents: {} }); const c = (loops.agents || {})[agentId];
  if (!c) out(2, { ok: false, error: agentId + ' is not on the crew (company/tools/loops.json)' });
  if (co.holds(c, 'people')) out(2, { ok: false, error: c.name + ' holds the people function. Hire the new people owner first (the CEO opens the role; hire.js hire --functions people); the new people owner then carries out this change.' });
  const heldFns = FUNCTIONS.filter(f => co.holds(c, f));   // anything else they held falls back to the CEO seat (co.seatFor)
  const approved = need(a, 'approved');
  { const allowed = c.manager && c.manager !== ceoId() ? [nameOf(c.manager)] : deciders(ceoId()); if (!approverOk(approved, allowed)) out(2, { ok: false, error: '--approved must start with who decided: ' + allowed.join(' or ') + ' (their manager; the people owner when the manager is the CEO)' }); }
  mustGovern('release', Object.assign({ by, ref: 'release:fire:' + agentId }, ASKS.fire({ name: c.name, title: c.title, agentId, reason, replace: !!a.replace, approved })));
  const base = String(c.name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const charter = (() => { try { return require('./dossier.js').charterFile(c, agentId); } catch (_) { return path.join(ROLES, base + '.md'); } })();
  const inboxFile = path.join(HANDOFFS, c.inbox);
  const openHandoffs = (() => { try { return fs.readFileSync(inboxFile, 'utf8').split(/^## /m).slice(1).filter(x => /^\*\*Status:\*\*\s*OPEN\b/m.test(x)).map(x => x.split('\n')[0].trim()); } catch (_) { return []; } })();
  const openQuests = ((JSON.parse((await C.call('GET', '/api/quests')).body).quests) || []).filter(q => q.status === 'open' && q.agentId === agentId).map(q => q.id + ' ' + q.title);
  const r = await C.call('POST', '/api/agent/delete', { agentId });
  if (r.status === 409) out(1, { ok: false, error: c.name + ' has a run in progress; retry when it ends' });
  { const rj = (() => { try { return JSON.parse(r.body); } catch (_) { return {}; } })(); if (r.status !== 200 || !rj.ok) out(1, { ok: false, error: 'station delete failed (' + r.status + '): ' + r.body.slice(0, 200) + '; nothing else was changed' }); }
  const keep = C.rosterRows().filter(x => x.agentId !== agentId);
  if (keep.length) { const rr = await C.call('POST', '/api/roster', { agents: keep, updatedAt: Date.now() }); if (!/"ok":true/.test(rr.body)) await C.call('POST', '/api/roster', { agents: keep, updatedAt: Date.now() + 1000 }); }
  await C.editSave(doc => {
    doc.agents = (doc.agents || []).filter(x => x.id !== agentId);
    for (const p of ((doc.station && doc.station.props) || [])) if (p && p.agentId === agentId) delete p.agentId;
    if (Array.isArray(doc.workstreams)) doc.workstreams = doc.workstreams.filter(w => !(w && w.agentId === agentId && !w.group && !w.worker));
  }, 'fire');
  // anyone who reported to this person gets an interim manager: the departed person's own manager, or the people owner
  // if that is the CEO
  const reports = Object.entries(loops.agents || {}).filter(([, x]) => x && x.manager === agentId).map(([id]) => id);
  const hrId = peopleId();
  const hr0 = hrId && loops.agents[hrId] ? [hrId, loops.agents[hrId]] : null;
  const interim = c.manager && c.manager !== ceoId() ? c.manager : (hrId || ceoId());
  for (const id of reports) loops.agents[id].manager = interim;
  delete loops.agents[agentId]; writeJson(LOOPS, loops);
  const day = stamp().slice(0, 10);
  const arch = path.join(HIRING, 'former', base + '-' + day);
  fs.mkdirSync(arch, { recursive: true });
  try { fs.copyFileSync(charter, path.join(arch, 'charter.md')); fs.unlinkSync(charter); } catch (_) {}
  try { fs.copyFileSync(inboxFile, path.join(arch, 'inbox.md')); fs.unlinkSync(inboxFile); } catch (_) {}
  fs.writeFileSync(path.join(arch, 'departure.md'), '# ' + c.name + ', ' + c.title + ': departure\n\n- Left ' + stamp() + '; decided: ' + approved + '; carried out by ' + by + '\n- Reports moved to interim manager ' + (nameOf(interim) || interim) + ': ' + (reports.map(nameOf).join(', ') || 'none') + '\n- Functions held: ' + (heldFns.join(', ') || 'none') + (heldFns.length ? ' (now with the CEO seat until moved with hire.js hire --functions)' : '') + '\n- Reason: ' + reason + '\n- Open handoffs at departure: ' + (openHandoffs.join('; ') || 'none') + '\n- Open quests at departure: ' + (openQuests.join('; ') || 'none') + '\n');
  let round = null;
  if (a.replace) {
    round = String(c.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 22).replace(/-$/, '') + '-replace-' + day;
    if (!ROUND_RE.test(round)) round = 'replace-' + base.slice(0, 12) + '-' + day;
    const dir = path.join(HIRING, round);
    if (!fs.existsSync(path.join(dir, 'round.json'))) {
      fs.mkdirSync(path.join(dir, 'interviews'), { recursive: true });
      saveRound(dir, { slug: round, role: c.title, manager: c.manager || ceoId(), openedBy: by, openedAt: new Date().toISOString(), request: 'Replace ' + c.name + ' (' + reason.slice(0, 200) + ')', replaces: agentId, candidates: [], hired: null });
      fs.writeFileSync(path.join(dir, 'log.md'), '# Hiring round ' + round + ': ' + c.title + ' (replacement)\n\n');
      logLine(dir, 'OPENED by ' + by + ' to replace ' + c.name + ': ' + reason.slice(0, 200));
      try { fs.copyFileSync(path.join(arch, 'charter.md'), path.join(dir, 'previous-charter.md')); } catch (_) {}
    }
  }
  const mgr = c.manager && (loops.agents || {})[c.manager];
  const inbox = mgr && c.manager !== ceoId() ? mgr.inbox : fnInbox('people');   // never the CEO: reassigning work is a manager's job
  if (inbox && (openHandoffs.length || openQuests.length)) fs.appendFileSync(path.join(HANDOFFS, inbox), '\n## ' + day + ' from hire.js — ' + c.name + ' has left; their open work needs an owner\n**Need:** reassign each item: write the handoff to its new owner, and re-mint each quest for its new owner (quests cannot change owner).\n**Why:** ' + c.name + ' (' + c.title + ') left: ' + reason.slice(0, 200) + '. Give each item to a colleague in the same function, or hold it for the replacement.\n**Deadline:** today\n**Status:** OPEN\n**Evidence:** `' + path.relative(ROOT, path.join(arch, 'departure.md')) + '`. Handoffs: ' + (openHandoffs.join('; ') || 'none') + '. Quests: ' + (openQuests.join('; ') || 'none') + '\n');
  if (reports.length && hr0) fs.appendFileSync(path.join(HANDOFFS, hr0[1].inbox), '\n## ' + day + ' from hire.js — ' + c.name + '\'s team now reports to ' + (nameOf(interim) || interim) + ' for now\n**Need:** confirm or change the interim manager for ' + reports.map(nameOf).join(', ') + ' (company/tools/loops.json manager), and update their charters\' Reports to line.\n**Why:** their manager ' + c.name + ' left.\n**Deadline:** today\n**Status:** OPEN\n**Evidence:** `' + path.relative(ROOT, path.join(arch, 'departure.md')) + '`\n');
  if (round && hr0) fs.appendFileSync(path.join(HANDOFFS, hr0[1].inbox), '\n## ' + day + ' from hire.js — run the replacement round for ' + c.title + ' (`' + round + '`)\n**Need:** run the round as usual; start the role spec from `company/hiring/' + round + '/previous-charter.md` and fix what made the last person fail (the reason below).\n**Why:** ' + c.name + ' left: ' + reason.slice(0, 200) + '\n**Deadline:** none set; the manager sets the priority\n**Status:** OPEN\n**Evidence:** `' + path.relative(ROOT, path.join(arch, 'departure.md')) + '`\n');
  let page = 'closed'; try { await C.syncPrompt(ceoId()); } catch (e) { if (/via:page/.test(e.message)) page = await C.reloadStationPage(); }
  staffLog('LEFT ' + c.name + ' (' + agentId + ', ' + c.title + ') by ' + by + ' (approved: ' + approved + '): ' + reason.slice(0, 200) + (round ? '; replacement round ' + round : ''));
  return { ok: true, agentId, name: c.name, archived: path.relative(ROOT, arch), openHandoffs: openHandoffs.length, openQuests: openQuests.length, reportsMovedTo: reports.length ? interim : null, replacementRound: round, stationPage: page };
}

async function release(a) {
  const { dir, round } = loadRound(need(a, 'round'));
  const agentId = need(a, 'agent'), reason = need(a, 'reason'), by = need(a, 'by');
  const cand = (round.candidates || []).find(c => c.agentId === agentId && c.status === 'candidate');
  if (!cand) out(2, { ok: false, error: agentId + ' is not an active candidate of this round' });
  // releasing the candidates a round did not pick follows from the hire (already decided under hiring); a release from a
  // round that hired nobody is its own decision
  if (!round.hired) mustGovern('release', Object.assign({ by, ref: 'release:candidate:' + round.slug + ':' + agentId }, ASKS.releaseCandidate({ name: cand.name, role: round.role, round: round.slug, agentId, reason })));
  const r = await C.call('POST', '/api/agent/delete', { agentId });
  const rj = (() => { try { return JSON.parse(r.body); } catch (_) { return {}; } })();
  if (r.status === 409) out(1, { ok: false, error: 'candidate has a run in progress; retry when it ends' });
  // StarNet's delete removes the live roster row but keeps its raw copy, and a station page that is behind merges
  // its next roster push against that raw copy, which brings the deleted agent back. A whole-roster
  // push without the agent clears both copies.
  const keep = C.rosterRows().filter(x => x.agentId !== agentId);
  if (keep.length) await C.call('POST', '/api/roster', { agents: keep, updatedAt: Date.now() });
  await C.editSave(doc => {
    doc.agents = (doc.agents || []).filter(x => x.id !== agentId);
    for (const p of ((doc.station && doc.station.props) || [])) if (p && p.agentId === agentId) delete p.agentId;
    if (Array.isArray(doc.workstreams)) doc.workstreams = doc.workstreams.filter(w => !(w && w.agentId === agentId && !w.group && !w.worker));
  }, 'hire-release');
  mutateRound(dir, r => { const c = (r.candidates || []).find(x => x.agentId === agentId && x.status === 'candidate'); if (c) Object.assign(c, { status: 'released', releasedAt: new Date().toISOString(), releasedBy: by, reason: reason.slice(0, 500) }); });
  // The CEO's prompt lists the crew; recompose it so a released candidate drops out. With a page open, reload it instead.
  try { await C.syncPrompt(ceoId()); } catch (e) { if (/via:page/.test(e.message)) await C.reloadStationPage(); }
  logLine(dir, 'RELEASED ' + cand.name + ' (' + agentId + ') by ' + by + ': ' + reason.slice(0, 200) + (rj.ok ? '' : ' [station delete: ' + r.body.slice(0, 100) + ']'));
  return { ok: true, agentId, stationDelete: rj, transcriptKept: cand.transcript || null };
}

async function models() {
  const r = await C.call('GET', '/api/providers');
  let j = {}; try { j = JSON.parse(r.body); } catch (_) {}
  const list = (j.providers || j || []);
  const rows = (Array.isArray(list) ? list : Object.values(list)).map(p => ({ id: p.id || p.provider, configured: !!(p.configured || (p.readiness && p.readiness.configured)), unattendedReady: p.unattendedReady }));
  const crew = C.rosterRows().map(x => ({ agent: x.agentId, provider: x.provider, model: x.model }));
  // a provider counts only if it actually lists models today (a provider can be configured with none installed)
  const live = [];
  for (const p of rows.filter(x => x.configured && x.id !== 'openrouter')) {
    try { const m = JSON.parse((await C.call('GET', '/api/models/' + encodeURIComponent(p.id))).body); const ids = (m.models || []).map(x => x.id); if (ids.length) live.push({ id: p.id, models: ids.slice(0, 12) }); } catch (_) {}
  }
  return { ok: true, providers: live, inUse: crew, allowedForHire: hireProviders(), candidateDefault: companyModel(), note: 'Only providers and models listed under allowed in company/model-policy.json may be used for candidates and hires. A hire keeps the model they interviewed on.' };
}

/* selftest: the self-governance levels and the spendCap guardrail, offline (a scratch company tree; no station). */
async function selftest() {
  const os = require('os'); const assert = require('assert');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'hire-selftest-'));
  const out = []; let bad = 0;
  const t = (n, fn) => { try { fn(); out.push('ok   ' + n); } catch (e) { bad++; out.push('FAIL ' + n + ': ' + e.message); } };
  const govFile = path.join(T, 'company', 'state', 'governance.json');
  const setLevel = (cat, lv) => { const d = readJson(govFile, null) || readJson(co.p('company', 'defaults', 'state', 'governance.json'), {}); d.categories[cat] = lv; writeJson(govFile, d); };
  const g = { root: T };
  const o = { by: 'Sam', ref: 'hiring:hire:qa-1:lee', summary: 'hire Lee as QA Lead from hiring round qa-1', default: 'nobody is hired' };
  t('hiring at auto: allowed, nothing sent', () => { setLevel('hiring', 'auto'); const r = governanceCheck('hiring', o, g); assert.ok(r.ok); assert.ok(!fs.existsSync(path.join(T, 'company', 'owner', 'outbound.jsonl'))); });
  t('hiring at notify: allowed, the owner is told in one sentence', () => {
    setLevel('hiring', 'notify'); const r = governanceCheck('hiring', o, g); assert.ok(r.ok);
    assert.ok(/^Sam decided to hire Lee as QA Lead/.test(JSON.parse(fs.readFileSync(path.join(T, 'company', 'owner', 'digest.jsonl'), 'utf8').trim()).text));   // an FYI: the day's single message
  });
  t('hiring at approve: refused with an owner question; goes on after the owner says yes', () => {
    setLevel('hiring', 'approve'); const r = governanceCheck('hiring', o, g); assert.ok(!r.ok && r.d.questionId); assert.ok(/waits for the owner/.test(r.error));
    require('./lib/pm-inbox-guard').append(path.join(T, 'company', 'pm-inbox.jsonl'), { type: 'answer', id: r.d.questionId, a: 'yes', by: 'Commander' }, 'selftest');
    assert.ok(governanceCheck('hiring', o, g).ok);
  });
  t('release and models read their own categories (release approve, models notify by default)', () => {
    assert.strictEqual(governanceCheck('release', { by: 'Sam', ref: 'release:fire:x', summary: 'release X' }, g).ok, false);
    assert.strictEqual(governanceCheck('models', { by: 'Sam', ref: 'models:remodel:x:p/m', summary: 'move X to p/m' }, g).ok, true);
  });
  const bf = path.join(T, 'budget.json'), rf = path.join(T, 'runs.jsonl');
  fs.writeFileSync(bf, JSON.stringify({ dailyUsd: 1 })); fs.writeFileSync(rf, JSON.stringify({ startedAt: Date.now(), provider: 'deepseek', usd: 5, agentId: 'a' }) + '\n');
  t('spendCap guardrail off: an over-cap interview is not stopped, and says it would have been', () => {
    const st = assertBudget('a', false, { root: T, guards: { spendCap: false }, budgetFile: bf, runsFile: rf });
    assert.ok(/would have stopped/.test(st.guardOff));
  });
  t('spendCap guardrail on: the over-cap state is still detected (the refusal path)', () => {
    const st = budgetState({ budgetFile: bf, runsFile: rf }); assert.ok(st.total >= st.cap);
  });
  t('separation of duties: a hire may not hold a seat and what it is independentOf', () => {
    const pd = path.join(T, 'company', 'state', 'packs', 'installed', 'desk'); fs.mkdirSync(pd, { recursive: true });
    writeJson(path.join(pd, 'pack.json'), { id: 'desk', seats: [{ name: 'trader', template: 'roles/trader.md' }, { name: 'reconciler', template: 'roles/reconciler.md', independentOf: ['trader', 'finance'] }] });
    const rules = independenceRules(T);
    assert.deepStrictEqual(rules['desk--reconciler'], ['desk--trader', 'finance']);
    assert.ok(/independent of finance/.test(independenceConflicts({ seats: ['desk--reconciler'], functions: ['finance'] }, rules).join()));
    assert.ok(/independent of desk--trader/.test(independenceConflicts({ seats: ['desk--reconciler', 'desk--trader'], functions: [] }, rules).join()));
    assert.strictEqual(independenceConflicts({ seats: ['desk--reconciler'], functions: ['people'] }, rules).length, 0);
    assert.strictEqual(independenceConflicts({ seats: ['desk--trader'], functions: ['finance'] }, rules).length, 0);
  });
  // the round's live stage, the pick seat, the scorecard rule and the profile reader (advance's mechanical steps)
  const R = path.join(T, 'round-x'); fs.mkdirSync(path.join(R, 'interviews'), { recursive: true }); fs.mkdirSync(path.join(R, 'profiles'), { recursive: true });
  const now = new Date().toISOString(), old = new Date(Date.now() - 3600e3).toISOString();
  const cand = (id, x) => Object.assign({ agentId: id, name: id.toUpperCase(), provider: 'p', model: 'm', status: 'candidate', createdAt: old }, x || {});
  const base = { slug: 'round-x', role: 'QA Lead', openedAt: old, openedBy: co.nameOf(ceoId()), candidates: [], hired: null };
  const stage = r => roundStage(R, Object.assign({}, base, r));
  t('stage: no files, no candidates -> needs-files (names role-spec.md and profiles/)', () => { const s = stage({}); assert.strictEqual(s.key, 'needs-files'); assert.ok(/role-spec\.md/.test(s.label) && /profiles\//.test(s.label)); });
  fs.writeFileSync(path.join(R, 'role-spec.md'), '# QA Lead\n## Scope\nTests.\n'); fs.writeFileSync(path.join(R, 'profiles', 'lee-park.md'), '# Candidate profile — Lee Park\n\n## Personality\nExact.\n\n## Model\ndeepseek/deepseek-flash high\n');
  t('stage: spec and profiles written -> candidates (mechanical: hire.js creates them)', () => assert.strictEqual(stage({}).key, 'candidates'));
  t('profile reader: name from the heading, model from "## Model"; a heading naming no one falls back to the file name', () => {
    assert.strictEqual(profileName('lee-park.md', readIf(path.join(R, 'profiles', 'lee-park.md'))), 'Lee Park');
    assert.strictEqual(profileName('quinn.md', '# Profile\n'), 'quinn');
    assert.deepStrictEqual(profileModel(readIf(path.join(R, 'profiles', 'lee-park.md'))), { provider: 'deepseek', model: 'deepseek-flash', effort: 'high' });
  });
  fs.writeFileSync(path.join(R, 'interview.md'), '# Q\n\n## One\n');
  t('stage: candidates waiting for interviews', () => assert.strictEqual(stage({ candidates: [cand('a'), cand('b')] }).key, 'candidates'));
  t('stage: a started interview is not started again (queued counts as running) -> interviewing 0/2', () => { const s = stage({ candidates: [cand('a', { interviewStartedAt: now }), cand('b', { interviewStartedAt: now })] }); assert.strictEqual(s.key, 'interviewing'); assert.strictEqual(s.label, 'interviewing 0/2'); });
  fs.writeFileSync(path.join(R, 'interviews', 'a.md'), '# Interview\n\n## Question 1\n\nq\n\n### Answer\n\nI would test it.\n\nFinished now.\n');
  t('stage: one transcript finished, one in flight -> interviewing 1/2', () => assert.strictEqual(stage({ candidates: [cand('a', { interviewStartedAt: old }), cand('b', { interviewStartedAt: now })] }).label, 'interviewing 1/2'));
  t('stage: all in (a failed twice counts as out) -> waiting for pick by the people holder (the CEO while it holds people)', () => {
    const s = stage({ candidates: [cand('a', { interviewedAt: now }), cand('b', { interviewFailures: 2, interviewStartedAt: old, interviewFailedAt: now })] });
    assert.strictEqual(s.key, 'waiting-pick'); assert.ok(s.label.endsWith(co.nameOf(peopleId())), s.label);
    assert.deepStrictEqual(pickSeats(base), [peopleId()]);
  });
  t('stage: a pick waiting on the owner, then hired, with the timeline in order', () => {
    assert.strictEqual(stage({ candidates: [cand('a', { interviewedAt: now })], pick: { agentId: 'a', name: 'A', by: 'X', at: now, waitingOwner: { at: now } } }).key, 'waiting-owner');
    const s = stage({ candidates: [cand('a', { interviewedAt: now, interviewStartedAt: old, status: 'hired', hiredAt: now, officeName: 'A' })], pick: { agentId: 'a', name: 'A', by: 'X', at: now }, hired: 'a' });
    assert.strictEqual(s.key, 'hired'); assert.deepStrictEqual(s.timeline.map(x => x.step.split(' ')[0]), ['opened', 'candidates', 'interviews', 'interviews', 'picked', 'hired']);
  });
  t('pick seats: a manager who is not the CEO decides with the people holder', () => { const c = co.crew(); const other = Object.keys(c).find(id => id !== ceoId()) || 'mgr-x'; assert.deepStrictEqual(pickSeats({ manager: other }).sort(), [...new Set([other, peopleId()])].sort()); });
  t('scorecard rule: highest total that clears the must-have bar; set by someone who does not decide = no pick', () => {
    const r = Object.assign({}, base, { candidates: [cand('a', { interviewedAt: now }), cand('c', { interviewedAt: now }), cand('d', { interviewedAt: now })], pickRule: { type: 'scores', min: 3.5, setBy: co.nameOf(peopleId()) } });
    assert.ok(rulePick(R, r).waiting, 'no scores.json yet: the rule waits');
    writeJson(path.join(R, 'scores.json'), { a: { total: 4.1, mustHaveAvg: 4 }, c: { total: 4.6, mustHaveAvg: 3.2 }, d: { total: 3.9, mustHaveAvg: 3.9, mustHaveMin: 3 } });
    const p = rulePick(R, r); assert.strictEqual(p.agentId, 'a'); assert.ok(/highest total 4\.1/.test(p.why));
    assert.ok(rulePick(R, Object.assign({}, r, { pickRule: { type: 'scores', setBy: 'Nobody' } })).none);
  });
  t('scorecard inputs: one row per candidate with its transcript and answer count, and a recommendation slot', () => {
    const f = writeScorecardInputs(R, Object.assign({}, base, { candidates: [cand('a', { interviewedAt: now, transcript: path.relative(ROOT, path.join(R, 'interviews', 'a.md')) })] }));
    const txt = fs.readFileSync(path.resolve(ROOT, f), 'utf8'); assert.ok(/\| A \| `a` \| p\/m \| `.*a\.md` \| 1 \| 0 \| 4 \|/.test(txt), txt); assert.ok(/## Recommendation/.test(txt));
  });
  fs.rmSync(T, { recursive: true, force: true });
  // interviews run side by side: the pool keeps --parallel in flight and returns results in order
  let inFlight = 0, peak = 0;
  const res = await pool([1, 2, 3, 4, 5], 3, async x => { inFlight++; peak = Math.max(peak, inFlight); await new Promise(r => setTimeout(r, 20)); inFlight--; return x * 2; });
  t('parallel interviews: at most 3 at once, all of them, in order', () => { assert.strictEqual(peak, 3); assert.deepStrictEqual(res, [2, 4, 6, 8, 10]); });
  const sres = await soft(() => need({}, 'round'));
  t('soft(): a refusal inside advance is a note, not the end of the process', () => { assert.strictEqual(sres.ok, false); assert.strictEqual(sres.code, 2); assert.strictEqual(sres.error, '--round is required'); });
  for (const l of out) console.log(l);
  console.log(bad ? 'HIRE SELFTEST FAILED: ' + bad : 'HIRE SELFTEST PASSED: ' + out.length + ' cases');
  return bad ? 1 : 0;
}

(async () => {
  if (require.main !== module) return;   // required as a module (tests): export the helpers, run no command
  const a = args();
  if (a.cmd === 'selftest' || a.cmd === '--selftest') process.exit(await selftest());
  if (a.cmd === 'open') {
    const slug = need(a, 'round'); const dir = roundDir(slug);
    if (fs.existsSync(path.join(dir, 'round.json'))) out(2, { ok: false, error: 'round exists' });
    const crew0 = co.crew();
    const manager = a.manager && a.manager !== true ? String(a.manager) : ceoId();
    if (!manager || !crew0[manager]) out(2, { ok: false, error: '--manager must be a station id from company/tools/loops.json (one of: ' + Object.keys(crew0).join(', ') + ')' });
    mustGovern('hiring', Object.assign({ by: need(a, 'by'), ref: 'hiring:open:' + slug }, ASKS.open({ role: need(a, 'role'), slug, request: a.request })));
    fs.mkdirSync(path.join(dir, 'interviews'), { recursive: true });
    const round = { slug, role: need(a, 'role'), manager, openedBy: need(a, 'by'), openedAt: new Date().toISOString(), request: a.request ? String(a.request).slice(0, 1000) : null, candidates: [], hired: null };
    // what the hire takes (used when the pick is recorded) and an optional scorecard rule that picks without a turn
    for (const k of ['functions', 'template', 'title']) if (a[k] && a[k] !== true) round[k] = String(a[k]);
    if (a['pick-rule'] === 'scores') round.pickRule = { type: 'scores', file: 'scores.json', min: Number.isFinite(Number(a.min)) ? Number(a.min) : 3.5, setBy: round.openedBy };
    saveRound(dir, round);
    fs.writeFileSync(path.join(dir, 'log.md'), '# Hiring round ' + slug + ': ' + round.role + '\n\n');
    logLine(dir, 'OPENED by ' + round.openedBy + (round.request ? ': ' + round.request : ''));
    out(0, { ok: true, round: slug, dir: path.relative(ROOT, dir), next: ['research.md', 'role-spec.md', 'model-fit.md', 'interview.md', 'scorecard.md', 'profiles/<name>.md for up to three candidates', 'then the round advances on its own (hire.js advance, run by the dispatcher each tick); the pick comes back to ' + pickSeats(round).map(co.nameOf).join(' and ') + ' as a handoff'] });
  }
  if (a.cmd === 'candidate') out(0, await createCandidate(a));
  if (a.cmd === 'interview') { const r = await interview(a); out(r.ok ? 0 : 1, r); }
  if (a.cmd === 'hire') out(0, await hire(a));
  if (a.cmd === 'advance') out(0, await advance(a));
  if (a.cmd === 'pick') out(0, await pickCmd(a));
  if (a.cmd === 'release') out(0, await release(a));
  if (a.cmd === 'remodel') out(0, await remodel(a));
  if (a.cmd === 'fire') out(0, await fire(a));
  if (a.cmd === 'status') { const { dir, round } = loadRound(String(a._ || need(a, 'round'))); out(0, { ok: true, stage: roundStage(dir, round), round }); }
  if (a.cmd === 'models') out(0, await models());
  out(2, { ok: false, error: 'commands: open, candidate, interview, advance, pick, hire, release, remodel, fire, status, models, selftest' });
})().catch(e => out(1, { ok: false, error: e.message }));

module.exports = { ASKS, answerTurn, selftest, roundStage, pickSeats, advanceRound, rulePick, profileName, profileModel, pool, soft, openRounds, independenceRules, independenceConflicts, governanceCheck, budgetState, assertBudget, candidateSkin, deskHandoff, writeJson, moveFunctions, setSection, deciders, approverOk, companyModel };   // test seam only; hire.js is run as a script everywhere else
