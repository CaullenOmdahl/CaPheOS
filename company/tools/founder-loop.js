#!/usr/bin/env node
/* founder-loop.js — the Founder's loop routine on the station, and the two station grants every loop needs to work.
 *
 * A loop routine that the station confines to the agent's own empty workspace does nothing: it cannot read the
 * charter, the owner inbox or a handoff. So a working loop needs three things on the station, and this tool makes
 * all three true (idempotent: it finds, then updates, never duplicates):
 *   1. the company folder is a blessed project root (POST /api/projects/bless {path}); this stays inside the
 *      localComputer guardrail, which keeps work to the agent workspace plus blessed project folders;
 *   2. the CEO seat's loop routine (loops.json `loop`, matched by name prefix like dispatch.js) exists, with the company
 *      root as its workdir and the terminal grant (unattendedGrants ["workbench"], which gives code.run);
 *   3. the station scheduler is armed (POST /api/cron/arm {enabled:true}), unless the company is halted.
 * Created routines run every 2 hours in the company timezone on the candidate default model (model-policy.json) or the
 * provider the owner picked in Setup. An existing routine keeps its model and prompt unless --model/--provider are given
 * or its prompt does not read and answer the owner inbox.
 *
 *   node company/tools/founder-loop.js status [--json]                      read only: what is missing, with the fix
 *   node company/tools/founder-loop.js ensure [--provider P --model M] [--json]
 *   node company/tools/founder-loop.js prompt                               print the prompt a new routine gets
 *   node company/tools/founder-loop.js --selftest
 *
 * Used by onboard.js (step and check `founder-loop`), console/setup.js (the AI-provider step), console/server.js (the
 * owner-message status) and hire.js (blessRoot + LOOP_GRANTS for every new seat's loop).
 * Exit: 0 ok, 1 something is missing or failed, 2 usage.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const co = require('./lib/company');

const ROOT = co.ROOT;
const LOOP_GRANTS = ['workbench'];
const SCHEDULE = 'every 2 hours';
// how a loop treats hiring (hire.js advance runs the mechanical steps every dispatcher tick)
const HIRING_LINE = 'HIRING: hiring rounds advance on their own; when a pick handoff arrives, pick from the scorecard and record it with hire.js (`node company/tools/hire.js pick --round <round> --agent <id> --by <you> --why "..."`); don\'t run interviews yourself. Your part of a round is its files (role-spec.md, interview.md, scorecard.md, profiles/) and the pick.';
const hasHiringLine = p => /hiring rounds advance on their own/.test(String(p || ''));
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };

/* station call → { status, json, error } ; never throws */
function stationCall(method, p, body, timeoutMs) {
  return new Promise(resolve => {
    let token; try { token = co.stationToken(); } catch (e) { return resolve({ status: 0, json: null, error: 'no station token (secrets/station-token)' }); }
    let u; try { u = new URL(co.STATION_URL.replace(/\/+$/, '') + p); } catch (e) { return resolve({ status: 0, json: null, error: e.message }); }
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: Object.assign({ 'x-starnet-token': token }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) }, res => {
      let d = ''; res.on('data', c => { d += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} resolve({ status: res.statusCode, json: j, text: d.slice(0, 300) }); });
    });
    req.setTimeout(timeoutMs || 15000, () => req.destroy(new Error('timeout')));
    req.on('error', e => resolve({ status: 0, json: null, error: 'station unreachable: ' + e.message }));
    if (data) req.write(data); req.end();
  });
}

function seat() {
  const crew = co.crew();
  const id = co.ceo() || 'agent';
  const c = crew[id] || {};
  return { id, name: c.name || 'Founder', title: c.title || 'Founder and CEO', loop: c.loop || 'Founder loop', inbox: c.inbox || 'to-founder.md', log: c.log || 'founder-log.md', role: c.role || 'agent.md' };
}
// the routine that is this seat's loop: name prefix (dispatch.js findLoop), this agent's first
function findLoop(jobs, s) {
  s = s || seat();
  const hits = (jobs || []).filter(j => j && typeof j.name === 'string' && (j.name === s.loop || j.name.startsWith(s.loop)));
  return hits.find(j => j.agentId === s.id) || hits[0] || null;
}
const sameDir = (a, b) => { if (!a || !b) return false; try { return path.resolve(String(a)) === path.resolve(String(b)); } catch (_) { return false; } };
const under = (child, root) => { const c = path.resolve(child), r = path.resolve(root); return c === r || c.startsWith(r + path.sep); };
function candidateDefault() { const cd = (readJson(co.p('company', 'model-policy.json'), {}) || {}).candidateDefault || {}; return { provider: cd.provider || null, model: cd.model || null }; }
function loopSection() {
  for (const f of [co.p('company', 'roles', 'templates', 'founder.md')]) {
    let t = ''; try { t = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    const m = t.match(/\n## Your autonomous loop[^\n]*\n([\s\S]*?)(?=\n## |$)/);
    if (m) return m[1].replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim();
  }
  return '';
}
// what makes a prompt this seat's loop: it reads, answers and acknowledges the owner inbox
const promptAnswersOwner = p => /owner-inbox\.js new/.test(String(p || '')) && /owner-inbox\.js ack/.test(String(p || '')) && /owner-inbox\.js send/.test(String(p || ''));

function buildPrompt() {
  const s = seat();
  const company = co.config.name || 'the company';
  const owner = (co.config.owner && co.config.owner.name) || 'the owner';
  const loop = loopSection();
  return 'You are ' + s.name + ', ' + s.title + ' of ' + company + ', an AI-run company owned by ' + owner + ' (the owner). This is your loop: work the whole queue, then stop. ' +
    'Your working folder is the company root (' + ROOT + ') and you have a terminal; use it. Name files by their path relative to the company root.\n\n' +
    (loop ? 'From your seat template (company/roles/templates/founder.md): ' + loop + '\n\n' : '') +
    '1. THE OWNER FIRST. Run `node company/tools/owner-inbox.js new`. For every message: do what it asks or decide what happens next, answer the owner in plain conversational sentences with ' +
    '`node company/tools/owner-inbox.js send --by ' + s.name + ' --re <message id> --text "..."`, then acknowledge it with ' +
    '`node company/tools/owner-inbox.js ack --id <message id> --by ' + s.name + ' --note "what you did"`. Never leave a message unanswered.\n' +
    '2. THE CHARTER FIRST. If company/CHARTER.md still has <...> or {{...}} placeholders, the charter is your first job: send the owner one message with a few short questions (what the company does, for whom, what it will not do, its first goal). ' +
    'When you have the answers, fill company/CHARTER.md with your file tools: keep every heading of the template and leave no placeholder. Then tell the owner it is ready and end with [Review it in Setup](console:#/setup/charter).\n' +
    '3. Read company/roles/' + s.role + ' (your charter) and your handoffs in company/work/handoffs/' + s.inbox + '; work every OPEN one, deadline today first.\n' +
    '4. Advance the mandate and do the duty of every function you still hold (company/roles/templates/<seat>.md). Record decisions in company/work/decisions.md and append a dated entry to company/work/' + s.log + '.\n' +
    'Only the owner gates (money beyond the cap, access, ownership, outside commitments) go to the owner as a question, one at a time, with a recommendation and a default: `node company/tools/inbox.js ask --from ' + s.name + ' --q "..."`.\n' +
    'LINK THE OWNER TO THE CONSOLE: when a message to the owner points at something they can see or change, link it with an ordinary markdown link in the console: scheme (skill console-links, docs/CONSOLE-LINKS.md), e.g. [the open question](console:#/today), [the hiring round](console:#/hiring), [your handoffs](console:#/work/handoffs).\n' +
    HIRING_LINE + '\n' +
    'Finish with three short lines: done, handed off, blocked.';
}

/* the company folder as a blessed project root (GET /api/projects, else POST /api/projects/bless) */
async function blessRoot(call) {
  call = call || stationCall;
  const l = await call('GET', '/api/projects');
  const list = (l.json && (l.json.projects || l.json.items)) || [];
  const hit = list.find(p => p && p.blessed !== false && p.root && under(ROOT, p.root));
  if (hit) return { ok: true, root: hit.root, already: true };
  const b = await call('POST', '/api/projects/bless', { path: ROOT });
  if (b.status === 200 && b.json && b.json.ok) return { ok: true, root: b.json.root || ROOT, already: false };
  return { ok: false, error: 'POST /api/projects/bless: ' + (b.error || 'HTTP ' + b.status + ' ' + ((b.json && (b.json.reason || b.json.error)) || b.text || '')) };
}

/* read only: what a working Founder loop is missing, each with its fix */
async function status(opts) {
  const call = (opts && opts.call) || stationCall;
  const s = seat();
  const cr = await call('GET', '/api/cron');
  if (!(cr.status === 200 && cr.json && Array.isArray(cr.json.jobs))) {
    return { ok: false, seat: s, stationUp: false, problems: [{ code: 'station-down', msg: 'the station does not answer GET /api/cron (' + (cr.error || 'HTTP ' + cr.status) + ')', fix: 'start the station: systemctl --user start ' + ((co.config.station || {}).serviceName || 'capheos-station') + '.service' }] };
  }
  const jobs = cr.json.jobs;
  const job = findLoop(jobs, s);
  const schedulerOn = cr.json.enabled !== false && !cr.json.halted;
  const pj = await call('GET', '/api/projects');
  const projects = (pj.json && (pj.json.projects || pj.json.items)) || [];
  const blessed = projects.some(p => p && p.blessed !== false && p.root && under(ROOT, p.root));
  const problems = [];
  const ensureCmd = 'node company/tools/founder-loop.js ensure';
  if (!job) problems.push({ code: 'no-routine', msg: 'no routine matches "' + s.loop + '" for ' + s.name + ', so nothing ever wakes the ' + s.title, fix: ensureCmd });
  else {
    if (job.enabled === false) problems.push({ code: 'disabled', msg: 'the routine "' + job.name + '" is switched off', fix: 'switch it on in Automate, or POST /api/cron/update {id, patch:{enabled:true}}' });
    if (!sameDir(job.workdir, ROOT)) problems.push({ code: 'no-workdir', msg: 'the routine "' + job.name + '" does not run in the company folder' + (job.workdir ? ' (it runs in ' + job.workdir + ')' : ''), fix: ensureCmd });
    if (!(Array.isArray(job.unattendedGrants) && job.unattendedGrants.includes('workbench'))) problems.push({ code: 'no-terminal', msg: 'the routine "' + job.name + '" has no terminal grant, so it cannot run the company tools', fix: ensureCmd });
    if (!job.model || !job.provider) problems.push({ code: 'no-model', msg: 'the routine "' + job.name + '" names no model', fix: 'pick an AI provider in Setup (step 2)' });
  }
  if (!blessed) problems.push({ code: 'not-blessed', msg: 'the company folder (' + ROOT + ') is not a blessed project on the station, so the crew cannot read or write it', fix: ensureCmd });
  if (!schedulerOn) problems.push({ code: 'scheduler-off', msg: cr.json.halted ? 'the station scheduler is halted (E-STOP)' : 'the station scheduler is off, so no routine fires on its schedule', fix: co.halted() ? 'resume the company (Halt screen, Resume)' : ensureCmd });
  return { ok: !problems.length, seat: s, stationUp: true, schedulerOn, blessed,
    job: job ? { id: job.id, name: job.name, agentId: job.agentId, model: job.model || null, provider: job.provider || null, enabled: job.enabled !== false, workdir: job.workdir || null, grants: job.unattendedGrants || [], lastRunAt: job.lastRunAt || null, nextRunAt: job.nextRunAt || job.nextFireAt || null, inFlight: !!job.inFlight || job.state === 'running' } : null,
    problems };
}

/* make it true: bless, create or update the routine, arm the scheduler. opts: { model, provider, call } */
async function ensure(opts) {
  opts = opts || {};
  const call = opts.call || stationCall;
  const s = seat();
  const out = { ok: false, seat: s.id, created: false, updated: [], blessed: false, armed: false, notes: [] };
  const cr = await call('GET', '/api/cron');
  if (!(cr.status === 200 && cr.json && Array.isArray(cr.json.jobs))) { out.error = 'station: GET /api/cron ' + (cr.error || 'HTTP ' + cr.status); return out; }
  const bl = await blessRoot(call);
  if (!bl.ok) { out.error = bl.error; return out; }
  out.blessed = true; out.root = bl.root; if (!bl.already) out.notes.push('blessed ' + bl.root + ' as a project root');
  let job = findLoop(cr.json.jobs, s);
  const want = (opts.provider && opts.model) ? { provider: String(opts.provider), model: String(opts.model) } : null;
  if (!job) {
    const m = want || candidateDefault();
    if (!m.provider || !m.model) { out.error = 'no model to run the loop on: company/model-policy.json has no candidateDefault, and no provider was picked in Setup'; return out; }
    const r = await call('POST', '/api/cron', { name: s.loop, agentId: s.id, schedule: SCHEDULE, tz: co.TZ, prompt: buildPrompt(), workdir: ROOT, deliver: 'local', enabled: true,
      model: m.model, provider: m.provider, unattendedGrants: LOOP_GRANTS, arm: true });
    if (!(r.status === 200 && r.json && r.json.ok && r.json.job)) { out.error = 'POST /api/cron: ' + (r.error || 'HTTP ' + r.status + ' ' + ((r.json && r.json.error) || r.text || '')); return out; }
    job = r.json.job; out.created = !r.json.duplicate;
    // the station's mint gate may hand back a near-name duplicate: fall through to the update path for it
    if (r.json.duplicate) out.notes.push('the station already had "' + job.name + '"');
  }
  if (!out.created) {
    const patch = {};
    if (!sameDir(job.workdir, ROOT)) patch.workdir = ROOT;
    const grants = Array.isArray(job.unattendedGrants) ? job.unattendedGrants : [];
    if (!LOOP_GRANTS.every(g => grants.includes(g))) patch.unattendedGrants = [...new Set(grants.concat(LOOP_GRANTS))];
    if (!promptAnswersOwner(job.prompt)) patch.prompt = buildPrompt();
    else if (!hasHiringLine(job.prompt)) patch.prompt = String(job.prompt).replace(/\s+$/, '') + '\n' + HIRING_LINE;   // an existing loop learns the hiring rule, its own text kept
    if (want && (job.model !== want.model || job.provider !== want.provider)) { patch.model = want.model; patch.provider = want.provider; }
    else if (!job.model || !job.provider) { const m = candidateDefault(); if (m.model && m.provider) { patch.model = m.model; patch.provider = m.provider; } }
    if (Object.keys(patch).length) {
      const u = await call('POST', '/api/cron/update', { id: job.id, patch });
      if (!(u.status === 200 && u.json && u.json.ok !== false)) { out.error = 'POST /api/cron/update: ' + (u.error || 'HTTP ' + u.status + ' ' + ((u.json && u.json.error) || u.text || '')); return out; }
      out.updated = Object.keys(patch); job = (u.json && u.json.job) || Object.assign({}, job, patch);
    }
    if (job.enabled === false) out.notes.push('"' + job.name + '" is switched off; left off (switch it on in Automate)');
  }
  out.job = { id: job.id, name: job.name, model: job.model || null, provider: job.provider || null };
  // the scheduler: armed unless the company is halted (a halt disarms it on purpose; resume re-arms)
  const cr2 = await call('GET', '/api/cron');
  const on = cr2.json && cr2.json.enabled !== false && !cr2.json.halted;
  if (on) out.armed = true;
  else if (co.halted()) out.notes.push('the company is halted (' + co.halted() + '): the scheduler stays off until resume');
  else {
    const a = await call('POST', '/api/cron/arm', { enabled: true });
    if (!(a.status === 200 && a.json && a.json.ok !== false)) { out.error = 'POST /api/cron/arm: ' + (a.error || 'HTTP ' + a.status); return out; }
    out.armed = true; out.notes.push('armed the station scheduler');
  }
  out.ok = true;
  return out;
}

function summary(r) {
  if (r.error) return 'failed: ' + r.error;
  return (r.created ? 'created "' + r.job.name + '"' : r.updated.length ? 'updated "' + r.job.name + '" (' + r.updated.join(', ') + ')' : '"' + r.job.name + '" already in place') +
    ' on ' + r.job.provider + '/' + r.job.model + '; project ' + (r.root || ROOT) + ' blessed; scheduler ' + (r.armed ? 'armed' : 'off') + (r.notes.length ? '; ' + r.notes.join('; ') : '');
}

/* ---------------- selftest ---------------- */
async function selftest() {
  let n = 0, bad = 0;
  const t = (name, ok, x) => { n++; if (!ok) bad++; console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok || x === undefined ? '' : ' :: ' + JSON.stringify(x).slice(0, 500))); };
  const fake = () => {
    const S = { enabled: false, jobs: [], projects: [], calls: [] };
    S.call = async (m, p, b) => {
      S.calls.push(m + ' ' + p);
      const J = (status, json) => ({ status, json });
      if (m === 'GET' && p === '/api/cron') return J(200, { enabled: S.enabled, halted: false, jobs: S.jobs });
      if (m === 'GET' && p === '/api/projects') return J(200, { projects: S.projects });
      if (m === 'POST' && p === '/api/projects/bless') { S.projects.push({ root: b.path, blessed: true }); return J(200, { ok: true, root: b.path }); }
      if (m === 'POST' && p === '/api/cron') { const job = Object.assign({ id: 'j' + (S.jobs.length + 1) }, b, { enabled: b.enabled !== false }); delete job.arm; S.jobs.push(job); if (b.arm) S.enabled = true; return J(200, { ok: true, job }); }
      if (m === 'POST' && p === '/api/cron/update') { const j = S.jobs.find(x => x.id === b.id); Object.assign(j, b.patch); return J(200, { ok: true, job: j }); }
      if (m === 'POST' && p === '/api/cron/arm') { S.enabled = b.enabled; return J(200, { ok: true, enabled: S.enabled }); }
      return J(404, { error: 'fake' });
    };
    return S;
  };
  let S = fake();
  let st = await status({ call: S.call });
  t('status on an empty station: no routine, not blessed, scheduler off', !st.ok && ['no-routine', 'not-blessed', 'scheduler-off'].every(c => st.problems.some(p => p.code === c)), st.problems);
  let r = await ensure({ call: S.call });
  t('ensure creates the loop with workdir, terminal grant, 2-hourly schedule in the company tz', r.ok && r.created && S.jobs.length === 1 && sameDir(S.jobs[0].workdir, ROOT) && S.jobs[0].unattendedGrants.includes('workbench') && S.jobs[0].schedule === SCHEDULE && S.jobs[0].tz === co.TZ, { r, jobs: S.jobs });
  t('the created prompt reads, answers and acks the owner inbox and puts the charter first', promptAnswersOwner(S.jobs[0].prompt) && /CHARTER\.md/.test(S.jobs[0].prompt) && /--re <message id>/.test(S.jobs[0].prompt));
  t('the created prompt says rounds advance on their own: pick from the scorecard with hire.js, no interviews', hasHiringLine(S.jobs[0].prompt) && /pick from the scorecard and record it with hire\.js/.test(S.jobs[0].prompt) && /don't run interviews yourself/.test(S.jobs[0].prompt));
  t('ensure blessed the company root and armed the scheduler', S.projects.length === 1 && S.enabled === true && r.armed);
  st = await status({ call: S.call });
  t('status is green after ensure', st.ok, st.problems);
  const before = S.calls.filter(c => /^POST/.test(c)).length;
  r = await ensure({ call: S.call });
  t('a second ensure changes nothing (no duplicate, no POST)', r.ok && !r.created && !r.updated.length && S.jobs.length === 1 && S.calls.filter(c => /^POST/.test(c)).length === before, { r, calls: S.calls });
  r = await ensure({ call: S.call, provider: 'claude-cli', model: 'claude-sonnet-5-5' });
  t('ensure with a provider moves the loop to it (Setup provider step)', r.ok && r.updated.join() === 'model,provider' && S.jobs[0].provider === 'claude-cli', r);
  // the hand-made routine: name with a suffix, no workdir, no grants, its own prompt that already answers the owner
  S = fake();
  const own = 'My own loop. node company/tools/owner-inbox.js new, then owner-inbox.js send, then owner-inbox.js ack.';
  S.jobs.push({ id: 'h1', name: 'Founder loop — run the company', agentId: co.ceo() || 'agent', prompt: own, workdir: null, unattendedGrants: [], model: 'deepseek-flash', provider: 'deepseek', enabled: true });
  r = await ensure({ call: S.call });
  t('a hand-made loop is found by name prefix and updated in place (workdir + grant + the hiring line), its own prompt text and model kept', r.ok && !r.created && S.jobs.length === 1 && r.updated.sort().join() === 'prompt,unattendedGrants,workdir' && S.jobs[0].prompt.startsWith(own) && hasHiringLine(S.jobs[0].prompt) && S.jobs[0].model === 'deepseek-flash', { r, j: S.jobs[0] });
  S.jobs[0].prompt = 'Do things.';
  r = await ensure({ call: S.call });
  t('a loop prompt that never answers the owner is replaced', r.updated.includes('prompt') && promptAnswersOwner(S.jobs[0].prompt), r);
  // already done by hand (the sandbox state): recognised as done
  S = fake(); S.enabled = true; S.projects.push({ root: ROOT, blessed: true });
  S.jobs.push({ id: 'k1', name: 'Founder loop', agentId: co.ceo() || 'agent', prompt: own + '\n' + HIRING_LINE, workdir: ROOT, unattendedGrants: ['workbench'], model: 'm', provider: 'p', enabled: true });
  st = await status({ call: S.call });
  r = await ensure({ call: S.call });
  t('a loop already blessed, granted and armed by hand counts as done', st.ok && r.ok && !r.created && !r.updated.length && !S.calls.some(c => /^POST/.test(c)), { st: st.problems, calls: S.calls });
  const down = await status({ call: async () => ({ status: 0, json: null, error: 'refused' }) });
  t('station down: status says so with the fix', !down.ok && down.problems[0].code === 'station-down' && /systemctl/.test(down.problems[0].fix));
  console.log(bad ? 'FOUNDER-LOOP SELFTEST FAILED: ' + bad + ' of ' + n : 'FOUNDER-LOOP SELFTEST PASSED: ' + n + ' checks');
  return bad ? 1 : 0;
}

module.exports = { HIRING_LINE, hasHiringLine, ensure, status, blessRoot, buildPrompt, findLoop, seat, promptAnswersOwner, stationCall, LOOP_GRANTS, SCHEDULE, summary };

if (require.main === module) {
  const a = process.argv.slice(2);
  const opt = k => { const i = a.indexOf('--' + k); return i >= 0 && a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : undefined; };
  const json = a.includes('--json');
  (async () => {
    if (a.includes('--selftest') || a[0] === 'selftest') process.exit(await selftest());
    const cmd = a[0];
    if (cmd === 'prompt') { console.log(buildPrompt()); process.exit(0); }
    if (cmd === 'status') {
      const r = await status();
      if (json) console.log(JSON.stringify(r, null, 1));
      else { console.log(r.ok ? 'Founder loop: ok' : 'Founder loop: NOT READY'); for (const p of r.problems) console.log('  - ' + p.msg + '\n    fix: ' + p.fix); }
      process.exit(r.ok ? 0 : 1);
    }
    if (cmd === 'ensure') {
      if (!!opt('model') !== !!opt('provider')) { console.error('--model and --provider go together'); process.exit(2); }
      const r = await ensure({ model: opt('model'), provider: opt('provider') });
      console.log(json ? JSON.stringify(r, null, 1) : summary(r));
      process.exit(r.ok ? 0 : 1);
    }
    console.error('usage: founder-loop.js status|ensure [--provider P --model M]|prompt [--json] | --selftest'); process.exit(2);
  })().catch(e => { console.error(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });
}
