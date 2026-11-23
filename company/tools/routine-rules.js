#!/usr/bin/env node
/* routine-rules.js — keep the house rules for scheduled runs at the end of every routine prompt.
 *
 *   node company/tools/routine-rules.js check     list routines that lack the current rules (or carry a stale corrections block)
 *   node company/tools/routine-rules.js ensure    add or refresh the rules where they are missing or old (idempotent)
 *   node company/tools/routine-rules.js selftest  check the own-section + house-rules + standing-corrections combination offline
 *
 * The dispatcher runs `ensure` on every tick, so a routine created or rewritten later (hire.js, the people owner, the
 * CEO, a prompt script) gets the rules back within ten minutes without anyone remembering to add them.
 *
 * Why these rules (found from the station's diagnostics):
 *  1. Relative paths. With Full Access, a file tool (fs_write/fs_edit/fs_append/fs_patch) given an ABSOLUTE path makes
 *     StarNet try to snapshot the whole disk before the write (starnet/sidecar/pathtrust.js unrestrictedHost base "/",
 *     run-paths.js checkpointResolvedRoot). The walk takes about half a second, fails on system folders, and the write
 *     gets no restore point. A relative path in a routine resolves to the company root, a blessed project, so the write
 *     gets a proper project snapshot. Only routines whose workdir is the company root get this rule: in an interactive
 *     chat a relative path lands in the agent's private workspace instead.
 *  2. Scratch files under scratch/ (listed in the root .gitignore, so checkpoints skip it), not /tmp.
 *  4. The 90-minute wall (v2): a long research run can do hundreds of real steps and be cut off at 90 minutes before
 *     its report, because nothing told the agent the limit existed.
 *  5. Routine models (v3): the pacer sets them from the people owner's routing table; a hand edit just fights the pacer.
 *  6. Decisions (v6): company/work/decisions.md is grow-only; agents write it only with company/tools/decision.js (add, amend,
 *     withdraw), because an in-place edit of a recent entry is a rewrite the locked-file watch flags.
 *  7. No sleeping to a wall-clock time (v7): on 2026-11-17 a run spent 40+ minutes in `sleep 236` loops waiting for
 *     15-minute market boundaries, holding its seat and blocking a station restart for everyone. Later work is a
 *     commitment with a due time; continuous recording is a background service. company/tools/shims/sleep refuses a
 *     sleep over 120 s on the station's PATH, and long-sleep.js flags a run that slept long anyway to the seat's manager.
 *  8. Module lines (v8): a rule that names a module's tool (company/tools/commitments.js) is written only while that module
 *     is enabled (company/state/modules.json); otherwise its FALLBACK line goes in, or the line is left out. On 2026-11-17 v7
 *     sent every seat to the commitments tool in a company that never enabled the module, and the Founder had to ask the owner
 *     to switch it on. The same goes for a company tool this checkout does not carry (deps.js, v8 line 2026-11-17): the
 *     line naming it is left out until the file exists. The block is rebuilt from the enabled modules on every tick, so enabling or disabling a module
 *     refreshes every routine within ten minutes, and existing companies get the fix through the same refresh.
 *     The fallback's "later" line names **Not before:** (2026-11-17): it said **Deadline:**, which the dispatcher then
 *     read as a start date, while the crew writes a Deadline to mean "finish by"; every dated item sat until its due day.
 *  9. No commands for the owner (v9): on 2026-11-17 the Founder's chat reply told the owner to run `systemctl --user stop
 *     …-liveness.timer` in a terminal. The owner works only in the console; Today's ask composer refused such asks, chat and
 *     handoffs did not. Every run now carries the rule, and the console flags a chat reply that breaks it (console/command-ask.js).
 * 10. Owner scope (v10): on 2026-11-17 the Founder asked the owner for health-check plumbing three times (a check "named
 *     recorder, period 5, grace 15", a timer "not on the service register … no new egress", a systemd start limit). The
 *     owner is a busy non-technical person; the ask composer now refuses crew-scope asks and unplain ones
 *     (company/tools/lib/owner-scope.js), and every run carries the rule.
 * 11. Credentials (v11): an agent that inspected a connector's credential files (cat with redaction, listing the CLI's
 *     config folder, session tokens) had two runs refused by the model provider's safety filter. A connector is checked
 *     through its own verify command (company/connectors/<id>.json `verify`) and its exit code; a credential file is
 *     never read or printed, which keeps keys out of transcripts and avoids the refusal.
 * 12. Waiting on, not guessed dates (v12): on 2026-11-17 22:24 the CEO parked ~13 handoffs behind **Not before:** dates
 *     that meant "after X is done", two core items for a week. Work that waits on other work names it in **Waiting on:**
 *     and is woken the tick it is met; a long job is started through notify-when.js, which wakes the seat when it ends;
 *     Not before is a real clock time with a reason, inside its caps (company/HANDOFFS.md). The fallback line says the same.
 * 13. Meeting etiquette (v13, 2026-11-18): the owner's meeting (console Chat › Meeting, console/meeting.js) puts every seat
 *     at one table in turn; a run that treats it like a chat (long reports, no PASS, raw questions to an observing owner)
 *     stalls it for everyone. The line says how to use ASK, INVITE, DISMISS, END and RULING, to keep replies short and to
 *     pass with nothing to add; the meeting's own preamble says the same at every turn.
 * 14. Meeting register (v14, 2026-11-18): the meeting's output is an action register its owners keep (owner ruling); the
 *     line adds the ACTION / QUESTION / KILL lines with their plain-language part, the leader's proposed RULING, and the
 *     speaking contract (point first, define terms, say what it means for the others in the room).
 * 15. The table again (v15, 2026-11-19): the owner found the console meeting stiffer than his terminal table; the
 *     speaking contract and the required plain parts made turns formulaic. The line is the table's again: speak as
 *     yourself, a few sentences, by name, PASS with nothing to add; "— plain: …" is welcome, not required.
 * 17. Short block (v17, 2026-11-23): the block went from ~8.7 KB to ~3.3 KB. Rules a tool already enforces with its own refusal message (sudo gate, ask composer, sleep shim, model pacer) keep one short line; meeting etiquette comes from console/meeting.js.
 * 16. Client work (v16, 2026-11-20): seats treated a product the company did not found as their own, added unrequested
 *     features and let security and QA set the client's release policy. The CLIENT WORK, BEFORE YOU DECIDE and class
 *     lines make the client's current way the brief, unrequested work a one-line suggestion, inherited unrequested
 *     behaviour a dated-notice removal, and override older "decide yourself" routine text. Only the four owner gates wait on the owner.
 *  3. Short waits. The station reclaims a routine run that shows no progress for 8 minutes (CRON_HEARTBEAT_STALE_MS
 *     480000), and a tool call in progress does not count, so one long shell_bg_wait loses the run's final reply.
 *
 * Standing corrections (1-on-1s): after the house rules, each routine owned by a person (job.agentId) also
 * carries that person's "[YOUR STANDING CORRECTIONS]" block, rendered by company/tools/corrections.js. ensure() keeps it
 * current on every tick: added, refreshed in place when a correction changes, removed when the person has none. If
 * corrections.js cannot be loaded or fails, the house rules still go on and any existing block is left as it is.
 *
 * Own sections (three-tier latitude; v4): each person may keep a short "[MY OWN SECTION]" of
 * notes to themselves in every routine they own, written only with company/tools/my-section.js. ensure() puts it directly
 * BEFORE the house rules (before the corrections block where a routine has no house rules), so the order is always
 *   [the routine's own text][MY OWN SECTION][HOUSE RULES][STANDING CORRECTIONS]
 * and the managed blocks have the last word. withRules() and withCorrections() never rewrite text before their own block,
 * so they cannot touch it. A section edited inside the routine is replaced from the store on the next tick; a store that
 * cannot be read leaves the section in the prompt as it is. If the station refuses a prompt with the section (400 blocked),
 * the tick saves the prompt once more without it, so the house rules and corrections still land, and my-section.js turns
 * that section off and tells the person.
 */
'use strict';
const path = require('path');
const call = (...a) => require('./station-crew.js').call(...a);   // loaded on first use, so the selftest needs no token
const co = require('./lib/company');
const ROOT = co.ROOT;
const VERSION = 'v17';
const START = '[HOUSE RULES FOR SCHEDULED RUNS ';
const END = '[END HOUSE RULES]';
const BLOCK = START + VERSION + ']\n' + [
  '- In fs_write, fs_edit, fs_append and fs_patch, use paths relative to the company root (company/work/...), never ' + ROOT + '/...: an absolute path makes the station back up the whole disk first and leaves no restore point. Temporary files go under scratch/, not /tmp.',
  '- The owner is a busy non-technical person. Handle infrastructure yourself: tools, services, monitoring, framework bugs and process are the crew\'s. Ask the owner only for money beyond the company\'s limits, an account in their name, legal, ownership or commitment decisions, direction and priorities, or a gate reserved for them, in two plain sentences that say what they get or risk and what happens if they skip it (your default), details under --details. The owner works only in the console: never ask them to run a command or open a terminal.',
  '- A scheduled run stops at 90 minutes. After about 60, start nothing new; save your work, write your log and handoffs with exactly where you stopped, and end by 75.',
  '- Never wait inside a run for more than about 2 minutes, and never call shell_bg_wait with timeoutMs above 240000. Start a long job with node company/tools/notify-when.js --seat <you> --why "..." --id <id> -- <command>, hand off the next step with **Waiting on:** job: <id>, and end the run: you are woken when it ends.',
  '- To act at a later clock time, record a commitment (node company/tools/commitments.js create --title "..." --key <key> --owner <you> --due <ISO time>) and end the run; for continuous watching, propose a service (node company/tools/service.js propose).',
  '- Use **Waiting on:** for anything that waits on other work (to-<name>.md#<heading words>, q:N step <key>, file: <path>, service: <name>, job: <id>, seat: <name> — <heading words>): the holder is woken the tick it is met. Use **Not before:** only for a real clock time, with its reason after the date.',
  '- Never read, list or print a credential (secrets/, the station\'s .secrets/, a CLI\'s config folder), not even redacted; check a key only with its connector\'s verify command or the tool that uses it.',
  '- Record a decision only with node company/tools/decision.js add --by <your name> --text "..." --why "..." (amend or withdraw with the same tool); company/work/decisions.md is never edited by hand.',
  '- Install a package only with node company/tools/deps.js add <python|node> <package> --why "..." --by <your name>, never pip or npm by hand.',
  '- Routine models come from the routing table in company/model-policy.json (company/tools/pacer.js applies it); to change one, ask the people owner, never edit a routine\'s model.',
  '- CLIENT WORK: a product the company did not found, the owner\'s own included, is client work; its current behaviour and release flow are the brief. FIX (it fails to do what it did or what was agreed) and ASKED (requested; cite the client\'s message or issue) ship the normal way. Anything else unrequested is a one-line PROPOSAL to the client, not built. This overrides older routine text such as "decide yourself".',
  '- What you may change yourself, what you propose and what is locked: company/work/people/LATITUDE.md. Your own section above is your notes (change it with node company/tools/my-section.js); these rules and your standing corrections win.',
].join('\n') + '\n' + END;

// a module's tools (modules/<id>/module.json tools[].file basenames) -> the module id
function moduleTools() {
  const fs = require('fs'); const out = {};
  let ids = []; try { ids = fs.readdirSync(co.p('modules')); } catch (_) {}
  for (const id of ids) {
    const m = co.readJson(co.p('modules', id, 'module.json'), null);
    for (const t of (m && Array.isArray(m.tools) ? m.tools : [])) { const b = path.basename(String((t && t.file) || ''), '.js'); if (b) out[b] = id; }
  }
  return out;
}
// what a module line says when its module is off (no line = the rule is left out)
const FALLBACK = {
  commitments: '- To act at a later clock time, write the next step as a handoff to yourself with **Not before:** YYYY-MM-DD[ HH:MM] and the reason after the date, and end the run (a **Deadline:** is when work must be done, never a start time); for continuous watching, propose a service (node company/tools/service.js propose).',
};
let modulesOverride = null;   // the selftest's enabled list
function enabledModules() { if (modulesOverride) return modulesOverride; try { return require('./lib/modules').enabled(); } catch (_) { return []; } }
/* blockFor(enabled) — the house rules for a company with these modules enabled: a line naming a tool of a module that is
 * not enabled is swapped for its FALLBACK, or left out. With every module enabled it is BLOCK, byte for byte. */
function blockFor(enabled, tools) {
  const fs = require('fs');
  const on = new Set(enabled || []); const owner = tools || moduleTools();
  const lines = BLOCK.split('\n');
  const out = [lines[0]];
  for (const l of lines.slice(1, -1)) {
    const named = (l.match(/company\/tools\/([a-z0-9-]+)\.js/g) || []).map(x => x.slice(14, -3));
    // a line about a company tool that this checkout does not have (yet) is left out, like a disabled module's line
    if (named.some(n => !owner[n] && !fs.existsSync(path.join(__dirname, n + '.js')) && !moduleTools()[n])) continue;
    const off = [...new Set(named.map(n => owner[n]).filter(m => m && !on.has(m)))];
    if (!off.length) { out.push(l); continue; }
    const fb = off.length === 1 ? FALLBACK[off[0]] : null;
    if (fb) out.push(fb);
  }
  out.push(lines[lines.length - 1]);
  return out.join('\n');
}
const rulesBlock = () => blockFor(enabledModules());

const applies = job => !job.noAgent && path.resolve(String(job.workdir || '')) === ROOT && typeof job.prompt === 'string' && job.prompt.trim();
function withRules(prompt, block) {
  block = block || rulesBlock();
  const i = prompt.indexOf(START);
  if (i >= 0) {
    const e = prompt.indexOf(END, i);
    const rest = e >= 0 ? prompt.slice(e + END.length) : '';
    return (prompt.slice(0, i).replace(/\s+$/, '') + '\n\n' + block + rest).replace(/\s+$/, '');
  }
  return prompt.replace(/\s+$/, '') + '\n\n' + block;
}
const current = (prompt, block) => prompt.includes(block || rulesBlock());

// ---- standing corrections block (rendered by corrections.js; always the last thing in the prompt) ----
const C_START = '[YOUR STANDING CORRECTIONS]';
const C_END = '[END STANDING CORRECTIONS]';
function stripCorrections(prompt) {
  let out = prompt;
  for (let i = out.indexOf(C_START); i >= 0; i = out.indexOf(C_START)) {
    const e = out.indexOf(C_END, i);
    // an unterminated block (cut by hand) is dropped up to the next blank line, never further
    const stop = e >= 0 ? e + C_END.length : (out.indexOf('\n\n', i) >= 0 ? out.indexOf('\n\n', i) : out.length);
    const tail = out.slice(stop).replace(/^\s+/, '');
    out = out.slice(0, i).replace(/\s+$/, '') + (tail ? '\n\n' + tail : '');
  }
  return out.replace(/\s+$/, '');
}
function withCorrections(prompt, block) {
  if (!block && !prompt.includes(C_START)) return prompt;   // nothing to add or remove: leave the prompt byte for byte
  const base = stripCorrections(prompt);
  return block ? base + '\n\n' + block : base;
}
// corrections apply to every routine a person owns; the house rules only to routines that work in the company root
const owned = job => job && !job.noAgent && job.agentId && typeof job.prompt === 'string' && job.prompt.trim();

// ---- the person's own section (rendered by my-section.js; directly before the house rules, never after a managed block) ----
const O_END = '[END MY OWN SECTION]';
const O_START_RE = /(^|\n)\[MY OWN SECTION\b[^\]\n]*\]/;   // by prefix, at a line start: a renamed person never leaves a stale block
function stripOwn(prompt) {
  let out = prompt;
  for (let guard = 0; guard < 20; guard++) {
    const m = O_START_RE.exec(out); if (!m) break;
    const i = m.index + m[1].length;
    const managed = [out.indexOf(START, i), out.indexOf(C_START, i)].filter(x => x >= 0);
    const nextManaged = managed.length ? Math.min(...managed) : -1;
    const e = out.indexOf(O_END, i);
    let stop;
    if (e >= 0 && (nextManaged < 0 || e < nextManaged)) stop = e + O_END.length;
    // an unterminated section (cut by hand) is dropped up to the next managed block, else the next blank line, never further
    else if (nextManaged >= 0) stop = nextManaged;
    else { const b = out.indexOf('\n\n', i); stop = b >= 0 ? b : out.length; }
    const tail = out.slice(stop).replace(/^\s+/, '');
    out = out.slice(0, i).replace(/\s+$/, '') + (tail ? '\n\n' + tail : '');
  }
  return out.replace(/\s+$/, '');
}
function withOwn(prompt, block) {
  if (!block && !O_START_RE.test(prompt)) return prompt;   // nothing to add or remove: leave the prompt byte for byte
  const base = stripOwn(prompt);
  if (!block) return base;
  let at = base.indexOf(START); if (at < 0) at = base.indexOf(C_START);
  if (at < 0) return base + '\n\n' + block;
  const head = base.slice(0, at).replace(/\s+$/, '');
  return (head ? head + '\n\n' : '') + block + '\n\n' + base.slice(at);
}

// ---- the profile's reminder (lib/profile.js reminderFor; docs/PROFILES.md): with the company's profile policy at inject
// profile and reminder on, the seat's ~50-token reminder is the LAST line of every routine it owns (after the corrections),
// so it is the last thing the run reads before it starts. Stable per profile version, so the prompt's cache holds.
const R_TAG = '[REMINDER] ';
const R_RE = /\n*\[REMINDER\] [^\n]*/g;
const stripReminder = prompt => prompt.replace(R_RE, '').replace(/\s+$/, '');
const withReminder = (prompt, line) => line ? prompt.replace(/\s+$/, '') + '\n\n' + R_TAG + String(line).replace(/\s+/g, ' ').trim() : prompt;
function reminderOf(seat) { return require('./lib/profile').reminderFor(seat); }

async function ensure({ dry = false, log = console.log, call: get = call, blockFor, ownFor, ownBlocked, reminderFor } = {}) {
  const r = await get('GET', '/api/cron');
  if (r.status !== 200) throw new Error('GET /api/cron ' + r.status);
  const jobs = JSON.parse(r.body).jobs || [];
  let corr = blockFor;
  if (corr === undefined) { try { corr = require('./corrections.js').blockFor; } catch (e) { corr = null; log('STANDING CORRECTIONS ERROR: corrections.js did not load (' + e.message + '); corrections blocks left as they are'); } }
  let own = ownFor, mark = ownBlocked;
  if (own === undefined) { try { const M = require('./my-section.js'); own = M.blockFor; if (mark === undefined) mark = M.markBlocked; } catch (e) { own = null; log('OWN SECTION ERROR: my-section.js did not load (' + e.message + '); own sections left as they are'); } }
  const changed = [], refreshed = [], failed = [], corrErrors = [], ownChanged = [], ownErrors = [], ownOff = [], reminded = [];
  const rules = rulesBlock();   // once per tick: the house rules for the modules enabled now
  for (const job of jobs) {
    const rulesDue = applies(job) && !current(job.prompt, rules);
    let next = rulesDue ? withRules(job.prompt, rules) : job.prompt;
    let ownDue = false, ownBlock = '';
    if (own && owned(job)) {
      let b = null;
      try { b = own(String(job.agentId), { dry: !!dry }); } catch (e) { b = null; ownErrors.push(job.name + ': ' + e.message); }
      if (typeof b === 'string') { const n2 = withOwn(next, b); ownDue = n2 !== next; next = n2; ownBlock = b; }
    }
    let rem = null;
    if (owned(job)) { try { rem = (reminderFor || reminderOf)(String(job.agentId)); } catch (_) { rem = null; } }
    if (typeof rem === 'string' && (rem || R_RE.test(next))) next = stripReminder(next);   // before the corrections, so their block stays put
    R_RE.lastIndex = 0;
    let corrDue = false;
    if (corr && owned(job)) {
      let b = null;
      // dry: a dry ensure shows what a dry corrections tick in the same process would activate or retire
      try { b = corr(String(job.agentId), { companyRoot: path.resolve(String(job.workdir || '')) === ROOT, dry: !!dry }); } catch (e) { b = null; corrErrors.push(job.name + ': ' + e.message); }
      if (typeof b === 'string') { const n2 = withCorrections(next, b); corrDue = n2 !== next; next = n2; }
    }
    if (typeof rem === 'string') next = withReminder(next, rem);
    const remDue = next !== job.prompt && !rulesDue && !ownDue && !corrDue;
    if (!rulesDue && !ownDue && !corrDue && !remDue) continue;
    const label = job.name;
    if (dry) { if (rulesDue) changed.push(label); if (corrDue) refreshed.push(label); if (ownDue) ownChanged.push(label); if (remDue) reminded.push(label); continue; }
    let u = await get('POST', '/api/cron/update', { id: job.id, patch: { prompt: next } });
    // the station refused the prompt with the person's own section in it: save it once more without the section, so the
    // house rules and corrections still land, and turn that section off (my-section.js tells the person)
    if (u.status === 400 && ownBlock && /"blocked"/.test(String(u.body))) {
      let pattern = ''; try { pattern = String(JSON.parse(u.body).blocked || ''); } catch (_) {}
      const without = withOwn(next, '');
      const u2 = without !== next ? await get('POST', '/api/cron/update', { id: job.id, patch: { prompt: without } }) : u;
      if (require('./lib/station').cronResult(u2).ok) {
        u = u2; ownDue = false; ownOff.push(label + ' (' + (pattern || 'blocked') + ')');
        try { if (mark) mark(String(job.agentId), { job: label, patternId: pattern }); } catch (e) { ownErrors.push(label + ': could not mark the section off (' + e.message + ')'); }
      }
    }
    const uv = require('./lib/station').cronResult(u, 'update');   // a 200 can be a decline
    if (uv.ok) { if (rulesDue) changed.push(label); if (corrDue) refreshed.push(label); if (ownDue) ownChanged.push(label); if (remDue) reminded.push(label); }
    else failed.push(label + ' (' + (uv.status === 200 ? uv.reason : u.status + ' ' + String(u.body).slice(0, 120)) + ')');
  }
  if (changed.length) log((dry ? 'would add' : 'added') + ' house rules ' + VERSION + ' to: ' + changed.join(', '));
  if (ownChanged.length) log((dry ? 'would update' : 'updated') + ' own sections in: ' + ownChanged.join(', '));
  if (refreshed.length) log((dry ? 'would update' : 'updated') + ' standing corrections in: ' + refreshed.join(', '));
  if (reminded.length) log((dry ? 'would update' : 'updated') + ' profile reminders in: ' + reminded.join(', '));
  if (ownOff.length) log('OWN SECTION OFF: the station refused the prompt with the person\'s own section, saved without it: ' + ownOff.join('; '));
  if (ownErrors.length) log('OWN SECTION ERROR: ' + ownErrors.join('; ').slice(0, 300) + ' (those sections left as they are)');
  if (corrErrors.length) log('STANDING CORRECTIONS ERROR: ' + corrErrors.join('; ').slice(0, 300) + ' (those blocks left as they are)');
  if (failed.length) log('HOUSE RULES ERROR: could not update ' + failed.join('; '));
  return { changed, refreshed, failed, own: ownChanged, ownOff, reminded };
}

// Offline check of the combination (no station, no token): idempotent, refreshes, removes when empty, keeps the rules.
async function selftest() {
  const assert = require('assert');
  modulesOverride = Object.values(moduleTools()).concat(['commitments']);   // every module on: the rules are BLOCK
  const out = []; let bad = 0;
  const t = async (name, fn) => { try { await fn(); out.push('ok   ' + name); } catch (e) { bad++; out.push('FAIL ' + name + ': ' + e.message); } };
  const E = o => ensure(Object.assign({ ownFor: () => '', ownBlocked: () => {} }, o));   // the corrections checks run with no own sections (the live store is never read)
  const mk = (n, extra) => Object.assign({ id: 'j' + n, name: 'Job ' + n, agentId: 'designer', workdir: ROOT, prompt: 'You are Alex.\n\nDo the work.' }, extra || {});
  const station = jobs => { const posts = []; return { posts, call: async (m, p, body) => { if (m === 'GET') return { status: 200, body: JSON.stringify({ jobs }) }; posts.push(body); const j = jobs.find(x => x.id === body.id); j.prompt = body.patch.prompt; return { status: 200, body: '{"ok":true}' }; } }; };
  const blk = text => C_START + '\nHabits that came up in your 1-on-1s. Follow each one on this run.\n- ' + text + '\n' + C_END;
  let block = blk('No shell_bg_wait over 4 minutes. Instead: wait in steps. Example: timeoutMs 120000.');
  const bf = () => block;
  const jobs = [mk(1), mk(2, { workdir: '/elsewhere' }), mk(3, { noAgent: true }), mk(4, { agentId: '' }),
    mk(5, { prompt: 'Old.\n\n[HOUSE RULES FOR SCHEDULED RUNS v1]\n- old rule\n[END HOUSE RULES]' })];
  const S = station(jobs);
  await t('adds house rules, then the corrections block, at the end', async () => {
    await E({ call: S.call, blockFor: bf, log: () => {} });
    assert.ok(jobs[0].prompt.startsWith('You are Alex.\n\nDo the work.\n\n' + BLOCK + '\n\n' + C_START));
    assert.ok(jobs[0].prompt.endsWith(C_END));
  });
  await t('a routine outside the company root gets the block but not the house rules', async () => { assert.ok(!jobs[1].prompt.includes(START)); assert.ok(jobs[1].prompt.endsWith(C_END)); });
  await t('a noAgent routine is untouched; an owner-less one gets the house rules but no corrections', async () => { assert.strictEqual(jobs[2].prompt, 'You are Alex.\n\nDo the work.'); assert.strictEqual(jobs[3].prompt, 'You are Alex.\n\nDo the work.\n\n' + BLOCK); });
  await t('old house rules are refreshed and the block stays after them', async () => { assert.ok(jobs[4].prompt.includes(BLOCK) && !jobs[4].prompt.includes('old rule')); assert.ok(jobs[4].prompt.indexOf(BLOCK) < jobs[4].prompt.indexOf(C_START)); });
  await t('second ensure changes nothing (idempotent)', async () => { const n = S.posts.length; await E({ call: S.call, blockFor: bf, log: () => {} }); assert.strictEqual(S.posts.length, n); });
  await t('a changed block is refreshed in place, exactly one block', async () => {
    block = blk('Never give fs_write an absolute path. Instead: use a relative path. Example: company/work/x.md');
    await E({ call: S.call, blockFor: bf, log: () => {} });
    for (const j of [jobs[0], jobs[1], jobs[4]]) { assert.strictEqual(j.prompt.split(C_START).length, 2); assert.ok(j.prompt.includes('absolute path') && !j.prompt.includes('shell_bg_wait over')); }
  });
  await t('an empty block removes it; house rules and the rest stay byte for byte', async () => {
    block = '';
    await E({ call: S.call, blockFor: bf, log: () => {} });
    assert.strictEqual(jobs[0].prompt, 'You are Alex.\n\nDo the work.\n\n' + BLOCK);
    assert.strictEqual(jobs[1].prompt, 'You are Alex.\n\nDo the work.');
    const n = S.posts.length; await E({ call: S.call, blockFor: bf, log: () => {} }); assert.strictEqual(S.posts.length, n);
  });
  await t('a failing corrections renderer never strips a block and never stops the house rules', async () => {
    block = blk('Keep me.');
    await E({ call: S.call, blockFor: bf, log: () => {} });
    const fresh = mk(6); const S2 = station([jobs[0], fresh]); const logs = [];
    await E({ call: S2.call, blockFor: () => { throw new Error('boom'); }, log: l => logs.push(l) });
    assert.ok(jobs[0].prompt.includes('Keep me.')); assert.ok(fresh.prompt.includes(BLOCK)); assert.ok(logs.some(l => /STANDING CORRECTIONS ERROR/.test(l)));
  });
  await t('text after a block (written by hand) is kept when the block is refreshed', async () => {
    const j = mk(7, { prompt: 'Top.\n\n' + blk('Old.') + '\n\nHand note.' }); const S3 = station([j]);
    block = blk('New.');
    await E({ call: S3.call, blockFor: bf, log: () => {} });
    assert.ok(j.prompt.includes('Hand note.') && j.prompt.endsWith(block) && !j.prompt.includes('Old.'));
  });
  await t('dry run posts nothing, and asks the renderer for the dry view', async () => { const j = mk(8); const S4 = station([j]); const seen = []; const r = await E({ dry: true, call: S4.call, blockFor: (id, o) => { seen.push(o); return block; }, log: () => {} }); assert.strictEqual(S4.posts.length, 0); assert.deepStrictEqual(r.changed, ['Job 8']); assert.deepStrictEqual(r.refreshed, ['Job 8']); assert.ok(seen.length && seen.every(o => o.dry === true)); });

  // ---- own sections (v4) ----
  const own = (txt, name) => '[MY OWN SECTION — ' + (name || 'Alex') + ' writes this]\nNotes you wrote for yourself.\n' + txt + '\n' + O_END;
  let section = own('Start with my log.');
  const of = () => section;
  const cb = blk('Wait in steps.');
  await t('own section goes before the house rules, corrections after them: body, own, rules, corrections', async () => {
    const j = mk(20); const S5 = station([j]);
    await ensure({ call: S5.call, blockFor: () => cb, ownFor: of, ownBlocked: () => {}, log: () => {} });
    assert.strictEqual(j.prompt, 'You are Alex.\n\nDo the work.\n\n' + section + '\n\n' + BLOCK + '\n\n' + cb);
    const n = S5.posts.length; await ensure({ call: S5.call, blockFor: () => cb, ownFor: of, ownBlocked: () => {}, log: () => {} }); assert.strictEqual(S5.posts.length, n, 'second ensure changes nothing');
  });
  await t('profile reminder: the last line, after the corrections; stable; removed when the policy is off', async () => {
    const j = mk(23); const S7 = station([j]); let rem = 'You are Alex, the builder. Reply only as Alex.';
    const go = () => ensure({ call: S7.call, blockFor: () => cb, ownFor: () => '', ownBlocked: () => {}, reminderFor: () => rem, log: () => {} });
    await go();
    assert.ok(j.prompt.endsWith(cb + '\n\n' + R_TAG + rem), j.prompt.slice(-200));
    const n = S7.posts.length; await go(); assert.strictEqual(S7.posts.length, n, 'second ensure changes nothing');
    rem = ''; await go();
    assert.ok(!j.prompt.includes(R_TAG) && j.prompt.endsWith(cb));
  });
  await t('a routine without house rules gets the section before its corrections block (or at the end)', async () => {
    const j = mk(21, { workdir: '/elsewhere' }), k = mk(22, { workdir: '/elsewhere' }); const S6 = station([j, k]);
    await ensure({ call: S6.call, blockFor: id => (id === 'designer' ? cb : ''), ownFor: of, ownBlocked: () => {}, log: () => {} });
    assert.strictEqual(j.prompt, 'You are Alex.\n\nDo the work.\n\n' + section + '\n\n' + cb);
    const S7 = station([k]); k.prompt = 'You are Alex.\n\nDo the work.'; await ensure({ call: S7.call, blockFor: () => '', ownFor: of, ownBlocked: () => {}, log: () => {} });
    assert.strictEqual(k.prompt, 'You are Alex.\n\nDo the work.\n\n' + section);
  });
  await t('a changed section is refreshed in place (exactly one); a cleared one is removed and the rest is byte for byte', async () => {
    const j = mk(23); const S8 = station([j]);
    await ensure({ call: S8.call, blockFor: () => cb, ownFor: of, ownBlocked: () => {}, log: () => {} });
    section = own('Changed note.');
    await ensure({ call: S8.call, blockFor: () => cb, ownFor: of, ownBlocked: () => {}, log: () => {} });
    assert.strictEqual(j.prompt.split('[MY OWN SECTION').length, 2); assert.ok(j.prompt.includes('Changed note.') && !j.prompt.includes('Start with my log.'));
    section = '';
    await ensure({ call: S8.call, blockFor: () => cb, ownFor: of, ownBlocked: () => {}, log: () => {} });
    assert.strictEqual(j.prompt, 'You are Alex.\n\nDo the work.\n\n' + BLOCK + '\n\n' + cb);
    section = own('Start with my log.');
  });
  await t('a section moved by hand after the rules goes back before them; an unterminated one is cut up to the rules', async () => {
    const j = mk(24, { prompt: 'You are Alex.\n\nDo the work.\n\n' + BLOCK + '\n\n' + own('Old.') + '\n\n' + cb }); const S9 = station([j]);
    await ensure({ call: S9.call, blockFor: () => cb, ownFor: of, ownBlocked: () => {}, log: () => {} });
    assert.strictEqual(j.prompt, 'You are Alex.\n\nDo the work.\n\n' + section + '\n\n' + BLOCK + '\n\n' + cb);
    const k = mk(25, { prompt: 'You are Alex.\n\nDo the work.\n\n' + own('Cut.').replace(O_END, '') + 'more cut text\n\n' + BLOCK }); const S10 = station([k]);
    await ensure({ call: S10.call, blockFor: () => '', ownFor: of, ownBlocked: () => {}, log: () => {} });
    assert.strictEqual(k.prompt, 'You are Alex.\n\nDo the work.\n\n' + section + '\n\n' + BLOCK);
  });
  await t('a renamed person leaves no stale section (stripped by prefix); a mention mid-line is not a section', async () => {
    const j = mk(26, { prompt: 'You are Alex. See [MY OWN SECTION] notes.\n\n' + own('Old name.', 'Alexa') + '\n\n' + BLOCK }); const S11 = station([j]);
    await ensure({ call: S11.call, blockFor: () => '', ownFor: of, ownBlocked: () => {}, log: () => {} });
    assert.strictEqual(j.prompt, 'You are Alex. See [MY OWN SECTION] notes.\n\n' + section + '\n\n' + BLOCK);
  });
  await t('a failing own-section renderer leaves the section as it is and never stops the house rules', async () => {
    const j = mk(27, { prompt: 'You are Alex.\n\nDo the work.\n\n' + own('Keep me.') + '\n\n[HOUSE RULES FOR SCHEDULED RUNS v1]\n- old\n[END HOUSE RULES]' }); const S12 = station([j]); const logs = [];
    await ensure({ call: S12.call, blockFor: () => '', ownFor: () => { throw new Error('store broken'); }, ownBlocked: () => {}, log: l => logs.push(l) });
    assert.strictEqual(j.prompt, 'You are Alex.\n\nDo the work.\n\n' + own('Keep me.') + '\n\n' + BLOCK); assert.ok(logs.some(l => /OWN SECTION ERROR/.test(l)));
  });
  await t('a prompt the station refuses with the section is saved without it, and the section is turned off', async () => {
    const j = mk(28); const marks = []; const posts = [];
    const call2 = async (m, p, body) => { if (m === 'GET') return { status: 200, body: JSON.stringify({ jobs: [j] }) }; posts.push(body); if (body.patch.prompt.includes('[MY OWN SECTION')) return { status: 400, body: '{"error":"Blocked","blocked":"prompt_injection"}' }; j.prompt = body.patch.prompt; return { status: 200, body: '{"ok":true}' }; };
    const logs = []; const r = await ensure({ call: call2, blockFor: () => cb, ownFor: of, ownBlocked: (id, info) => marks.push([id, info]), log: l => logs.push(l) });
    assert.strictEqual(posts.length, 2); assert.strictEqual(j.prompt, 'You are Alex.\n\nDo the work.\n\n' + BLOCK + '\n\n' + cb);
    assert.deepStrictEqual(marks, [['designer', { job: 'Job 28', patternId: 'prompt_injection' }]]); assert.deepStrictEqual(r.failed, []); assert.ok(logs.some(l => /OWN SECTION OFF/.test(l)));
  });
  await t('a refusal that is not about the section does not turn the section off', async () => {
    const j = mk(29); const marks = []; const posts = [];
    const call3 = async (m, p, body) => { if (m === 'GET') return { status: 200, body: JSON.stringify({ jobs: [j] }) }; posts.push(body); return { status: 400, body: '{"error":"Blocked","blocked":"x"}' }; };
    const r = await ensure({ call: call3, blockFor: () => '', ownFor: of, ownBlocked: (id, info) => marks.push(id), log: () => {} });
    assert.strictEqual(posts.length, 2); assert.strictEqual(marks.length, 0); assert.strictEqual(r.failed.length, 1);
  });
  await t('dry run with sections posts nothing and lists them', async () => { const j = mk(30); const S13 = station([j]); const r = await ensure({ dry: true, call: S13.call, blockFor: () => '', ownFor: of, ownBlocked: () => {}, log: () => {} }); assert.strictEqual(S13.posts.length, 0); assert.deepStrictEqual(r.own, ['Job 30']); });
  await t('the house rules point to LATITUDE.md and never contain an own-section marker', async () => { assert.ok(BLOCK.includes('company/work/people/LATITUDE.md')); assert.ok(!O_START_RE.test(BLOCK) && !BLOCK.includes(O_END)); });
  // ---- module lines (v8) ----
  await t('with commitments off, the waiting rule names no commitments tool and keeps the wait advice; on, it is BLOCK', async () => {
    const off = blockFor([], { commitments: 'commitments' });
    assert.ok(!/commitments\.js/.test(off) && /handoff to yourself/.test(off) && /service\.js propose/.test(off));
    assert.strictEqual(off.split('\n').length, BLOCK.split('\n').length);
    assert.strictEqual(blockFor(['commitments'], { commitments: 'commitments' }), BLOCK);
  });
  await t('a module line with no fallback is left out while its module is off', async () => {
    const b = blockFor([], { decision: 'some-module' });
    assert.ok(!b.includes('decision.js add') && b.split('\n').length === BLOCK.split('\n').length - 1);
  });
  await t('enabling the module refreshes routines on the next ensure (v8 block in place of the fallback)', async () => {
    const j = mk(40); const S14 = station([j]);
    modulesOverride = ['none']; await E({ call: S14.call, blockFor: () => '', log: () => {} });
    assert.ok(!j.prompt.includes('commitments.js create') && j.prompt.includes(START + VERSION));
    modulesOverride = Object.values(moduleTools()).concat(['commitments']); await E({ call: S14.call, blockFor: () => '', log: () => {} });
    assert.ok(j.prompt.includes(BLOCK) && j.prompt.split(START).length === 2);
  });
  modulesOverride = null;
  return { out, bad };
}

module.exports = { ensure, BLOCK, blockFor, rulesBlock, moduleTools, FALLBACK, VERSION, withRules, withCorrections, stripCorrections, withOwn, stripOwn, ROOT, C_START, C_END, O_END };

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'selftest' || process.argv.includes('--selftest')) { selftest().then(({ out, bad }) => { for (const l of out) console.log(l); console.log(bad ? bad + ' FAILED' : 'all ' + out.length + ' checks passed'); process.exit(bad ? 1 : 0); }); }
  else if (cmd !== 'check' && cmd !== 'ensure') { console.log('usage: routine-rules.js check|ensure|selftest'); process.exit(2); }
  else ensure({ dry: cmd === 'check' }).then(({ changed, refreshed, failed, own }) => {
    if (!changed.length && !refreshed.length && !failed.length && !(own || []).length) console.log('every routine has house rules ' + VERSION + ', current own sections and current standing corrections');
    process.exit(failed.length ? 1 : 0);
  }).catch(e => { console.error(e.message); process.exit(1); });
}
