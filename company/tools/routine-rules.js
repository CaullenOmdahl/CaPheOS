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
const VERSION = 'v6';
const START = '[HOUSE RULES FOR SCHEDULED RUNS ';
const END = '[END HOUSE RULES]';
const BLOCK = START + VERSION + ']\n' + [
  '- In fs_write, fs_edit, fs_append and fs_patch, name files by their path relative to the company root, for example company/work/handoffs/to-<name>.md, never ' + ROOT + '/company/... An absolute path makes the station try to back up the whole disk before the write, which is slow and leaves your write with no restore point. Shell commands are not affected.',
  '- Put temporary files under scratch/ (a relative path), not /tmp.',
  '- The station stops a scheduled run at 90 minutes, mid-task and before your final report. Watch the clock: after about 60 minutes start no new research or build step; save what you have, write your log entry and handoffs, and end by 75 minutes. For a job bigger than one run, write down exactly where you stopped and what comes next, so your next run picks it up.',
  '- Routine models are set by the usage pacer (company/tools/pacer.js) from the routing table in company/model-policy.json, which the people owner keeps as model manager. Never change a routine\'s provider or model by hand: to change a pairing, ask the people owner to change the table.',
  '- Never call shell_bg_wait with timeoutMs above 240000. The station stops a run that shows no progress for 8 minutes, and the run loses its final reply. Wait in short steps; if a job needs longer than this run has, leave it writing to a log under scratch/, write a handoff that names the log, and end the run.',
  '- Use sudo only for the commands the gate allows: the company\'s docker use and read-only host diagnostics. The gate runs them through a broker automatically, so `sudo docker ...` and `sudo ufw status` work as before, but there is no general root: `sudo cat`, `sudo curl`, arbitrary files and dangerous docker flags are refused. Run anything else without sudo, or ask the risk owner to add it (company/work/security/sudo-gate.md).',
  '- Record a decision only with node company/tools/decision.js add --by <your name> --text "..." --why "...". Never edit company/work/decisions.md by hand, not even your own entry minutes later: to correct one run decision.js amend <id-or-stamp>, to take one back decision.js withdraw <id-or-stamp> (both with --by and --why; ids: decision.js list). The record is grow-only and an in-place edit is flagged as a rewrite.',
  '- What you may change on your own, what you propose for review, and what is locked: company/work/people/LATITUDE.md. Your own section above, if you have one, is your notes to yourself, changed only with node company/tools/my-section.js; where it differs from these rules or your standing corrections, these win.',
].join('\n') + '\n' + END;

const applies = job => !job.noAgent && path.resolve(String(job.workdir || '')) === ROOT && typeof job.prompt === 'string' && job.prompt.trim();
function withRules(prompt) {
  const i = prompt.indexOf(START);
  if (i >= 0) {
    const e = prompt.indexOf(END, i);
    const rest = e >= 0 ? prompt.slice(e + END.length) : '';
    return (prompt.slice(0, i).replace(/\s+$/, '') + '\n\n' + BLOCK + rest).replace(/\s+$/, '');
  }
  return prompt.replace(/\s+$/, '') + '\n\n' + BLOCK;
}
const current = prompt => prompt.includes(BLOCK);

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

async function ensure({ dry = false, log = console.log, call: get = call, blockFor, ownFor, ownBlocked } = {}) {
  const r = await get('GET', '/api/cron');
  if (r.status !== 200) throw new Error('GET /api/cron ' + r.status);
  const jobs = JSON.parse(r.body).jobs || [];
  let corr = blockFor;
  if (corr === undefined) { try { corr = require('./corrections.js').blockFor; } catch (e) { corr = null; log('STANDING CORRECTIONS ERROR: corrections.js did not load (' + e.message + '); corrections blocks left as they are'); } }
  let own = ownFor, mark = ownBlocked;
  if (own === undefined) { try { const M = require('./my-section.js'); own = M.blockFor; if (mark === undefined) mark = M.markBlocked; } catch (e) { own = null; log('OWN SECTION ERROR: my-section.js did not load (' + e.message + '); own sections left as they are'); } }
  const changed = [], refreshed = [], failed = [], corrErrors = [], ownChanged = [], ownErrors = [], ownOff = [];
  for (const job of jobs) {
    const rulesDue = applies(job) && !current(job.prompt);
    let next = rulesDue ? withRules(job.prompt) : job.prompt;
    let ownDue = false, ownBlock = '';
    if (own && owned(job)) {
      let b = null;
      try { b = own(String(job.agentId), { dry: !!dry }); } catch (e) { b = null; ownErrors.push(job.name + ': ' + e.message); }
      if (typeof b === 'string') { const n2 = withOwn(next, b); ownDue = n2 !== next; next = n2; ownBlock = b; }
    }
    let corrDue = false;
    if (corr && owned(job)) {
      let b = null;
      // dry: a dry ensure shows what a dry corrections tick in the same process would activate or retire
      try { b = corr(String(job.agentId), { companyRoot: path.resolve(String(job.workdir || '')) === ROOT, dry: !!dry }); } catch (e) { b = null; corrErrors.push(job.name + ': ' + e.message); }
      if (typeof b === 'string') { const n2 = withCorrections(next, b); corrDue = n2 !== next; next = n2; }
    }
    if (!rulesDue && !ownDue && !corrDue) continue;
    const label = job.name;
    if (dry) { if (rulesDue) changed.push(label); if (corrDue) refreshed.push(label); if (ownDue) ownChanged.push(label); continue; }
    let u = await get('POST', '/api/cron/update', { id: job.id, patch: { prompt: next } });
    // the station refused the prompt with the person's own section in it: save it once more without the section, so the
    // house rules and corrections still land, and turn that section off (my-section.js tells the person)
    if (u.status === 400 && ownBlock && /"blocked"/.test(String(u.body))) {
      let pattern = ''; try { pattern = String(JSON.parse(u.body).blocked || ''); } catch (_) {}
      const without = withOwn(next, '');
      const u2 = without !== next ? await get('POST', '/api/cron/update', { id: job.id, patch: { prompt: without } }) : u;
      if (u2.status === 200) {
        u = u2; ownDue = false; ownOff.push(label + ' (' + (pattern || 'blocked') + ')');
        try { if (mark) mark(String(job.agentId), { job: label, patternId: pattern }); } catch (e) { ownErrors.push(label + ': could not mark the section off (' + e.message + ')'); }
      }
    }
    if (u.status === 200) { if (rulesDue) changed.push(label); if (corrDue) refreshed.push(label); if (ownDue) ownChanged.push(label); }
    else failed.push(label + ' (' + u.status + ' ' + String(u.body).slice(0, 120) + ')');
  }
  if (changed.length) log((dry ? 'would add' : 'added') + ' house rules ' + VERSION + ' to: ' + changed.join(', '));
  if (ownChanged.length) log((dry ? 'would update' : 'updated') + ' own sections in: ' + ownChanged.join(', '));
  if (refreshed.length) log((dry ? 'would update' : 'updated') + ' standing corrections in: ' + refreshed.join(', '));
  if (ownOff.length) log('OWN SECTION OFF: the station refused the prompt with the person\'s own section, saved without it: ' + ownOff.join('; '));
  if (ownErrors.length) log('OWN SECTION ERROR: ' + ownErrors.join('; ').slice(0, 300) + ' (those sections left as they are)');
  if (corrErrors.length) log('STANDING CORRECTIONS ERROR: ' + corrErrors.join('; ').slice(0, 300) + ' (those blocks left as they are)');
  if (failed.length) log('HOUSE RULES ERROR: could not update ' + failed.join('; '));
  return { changed, refreshed, failed, own: ownChanged, ownOff };
}

// Offline check of the combination (no station, no token): idempotent, refreshes, removes when empty, keeps the rules.
async function selftest() {
  const assert = require('assert');
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
  return { out, bad };
}

module.exports = { ensure, BLOCK, VERSION, withRules, withCorrections, stripCorrections, withOwn, stripOwn, ROOT, C_START, C_END, O_END };

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'selftest' || process.argv.includes('--selftest')) { selftest().then(({ out, bad }) => { for (const l of out) console.log(l); console.log(bad ? bad + ' FAILED' : 'all ' + out.length + ' checks passed'); process.exit(bad ? 1 : 0); }); }
  else if (cmd !== 'check' && cmd !== 'ensure') { console.log('usage: routine-rules.js check|ensure|selftest'); process.exit(2); }
  else ensure({ dry: cmd === 'check' }).then(({ changed, refreshed, failed, own }) => {
    if (!changed.length && !refreshed.length && !failed.length && !(own || []).length) console.log('every routine has house rules ' + VERSION + ', current own sections and current standing corrections');
    process.exit(failed.length ? 1 : 0);
  }).catch(e => { console.error(e.message); process.exit(1); });
}
