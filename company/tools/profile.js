#!/usr/bin/env node
/* profile.js — a crew member's full profile: the only writer of company/people/profiles/<seat>.json, its history and the
 * people function's proposals (docs/PROFILES.md; the shape and the pure parts are lib/profile.js).
 *
 *   node company/tools/profile.js show <seat> [--json] [--console]     the profile (--console: plus history, open proposals,
 *                                                                       the preview and the owner's sentences, for Crew › Profile)
 *   node company/tools/profile.js list [--json]                        every seat: version, trial, open proposals
 *   node company/tools/profile.js check [--all] [--seat s] [--json]    validation, the history chain, hand edits inside the
 *                                                                       charter's profile markers, family notes (exit 1 on a failure)
 *   node company/tools/profile.js render <seat> [--block|--reminder|--charter|--preview] [--set <pointer>=<json>]...
 *        the injection block, the reminder, the charter section or the console preview; --set previews unsaved changes
 *   node company/tools/profile.js edit <seat> --set <pointer>=<json>... --base <version> --by owner [--why ".."] [--now]
 *        owner only, compare-and-swap on version (exit 4 when the base is stale). Voice and content apply now;
 *        temperament and counterpart changes are refused ("use try") unless --now (the owner's choice to skip the trial)
 *   node company/tools/profile.js undo <seat> --to <version> --by owner           the exact body of that version, as a new one
 *   node company/tools/profile.js try <seat> --set ... --base <version> [--days 7] --by owner
 *        the change as version N+1 with trial {from: N, until}; it reverts at `until` unless the owner keeps it
 *   node company/tools/profile.js trial keep|stop <seat> --by owner
 *   node company/tools/profile.js tick [--dry]                          the dispatcher's step: trials past their end revert
 *   node company/tools/profile.js propose <seat> --kind experience|voice|temperament|counterpart|content
 *        (--set ... | --text ".." for an experience) --why ".." [--source ".."] --by <people seat>
 *        the people function proposes; never for its own profile; the owner may propose too
 *   node company/tools/profile.js decide <pp-id> apply|decline|try --by <owner|CEO>
 *        the CEO only at its governance level for "profiles" (auto / notify; approve waits for the owner, exit 3).
 *        Experience, voice and content proposals apply at once; temperament and counterpart ones go to a trial
 *   node company/tools/profile.js migrate [--all|--seat s] --by <people seat|owner>   build profiles from the charters
 *   node company/tools/profile.js policy [show] | policy inject charter|profile | pov on|off | signoff off|shadow|live  --by owner
 *   node company/tools/profile.js --duty        events since the last week that may deserve an experience line (people)
 *   node company/tools/profile.js --selftest
 * Pointers are JSON pointers into the profile (/temperament/risk, /voice/words, /convictions/-, /counterpart). Values are
 * JSON (a bare word is read as text). No seat edits its own profile; inside an agent's run --by must be that run's seat.
 * Every applied change: an atomic write recorded with provenance, a hash-chained history row, the charter's person
 * sections re-rendered (inject profile), and one line in company/work/decisions.md.
 * Exit: 0 done, 1 duty due / check failed / selftest failed, 2 usage or refused, 3 waiting for the owner, 4 stale base.
 * Owner: the people function (the profiles) and the tools function (this file).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const co = require('./lib/company');
const P = require('./lib/profile');

const TOOL = 'profile.js';
const DAY = 86400e3;
class Refusal extends Error { constructor(msg, code, extra) { super(msg); this.code = code || 2; this.extra = extra || {}; } }
const S = { now: () => Date.now(), root: () => co.ROOT, crew: () => co.crew(), ceo: () => co.ceo() };   // seams for the tests
const O = () => ({ root: S.root() });
const str = v => (v === true || v == null ? '' : String(v));
const clean = (t, n) => String(t == null ? '' : t).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, n || 400);
const clone = o => JSON.parse(JSON.stringify(o == null ? null : o));
function writeAtomic(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + '.tmp-' + process.pid; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }
const prov = () => require('./provenance.js');
const nameOf = (crew, s) => (crew[s] && crew[s].name) || s;
const firstName = n => String(n || '').split(/\s+/)[0];

function args(argv) {
  const o = { pos: [], set: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { o.pos.push(argv[i]); continue; }
    const k = argv[i].slice(2), v = (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
    if (k === 'set') { if (v !== true) o.set.push(v); } else o[k] = v;
  }
  return o;
}

/* ---------------- who ---------------- */
function seatArg(v) {
  const name = str(v).trim(); if (!name) throw new Refusal('which seat? (a seat id or name)');
  const crew = S.crew(), low = name.toLowerCase();
  const id = crew[name] ? name : Object.keys(crew).find(k => String((crew[k] || {}).name || '').trim().toLowerCase() === low);
  if (!id) throw new Refusal('"' + name + '" is not on the crew (company/tools/loops.json)');
  return id;
}
function actor(by, cmd) {
  const name = str(by).trim(); if (!name) throw new Refusal('--by <name> is required');
  const own = require('./lib/owner');
  if (own.isOwnerName(name)) { const r = own.refusal(name, 'a profile change'); if (r) throw new Refusal(r); return { kind: 'owner', id: 'owner', name: (co.config.owner && co.config.owner.name) || 'the owner' }; }
  const crew = S.crew(), low = name.toLowerCase();
  const id = crew[name] ? name : Object.keys(crew).find(k => String((crew[k] || {}).name || '').trim().toLowerCase() === low);
  if (!id) throw new Refusal('--by "' + name + '" is not on the crew and is not the owner');
  let pv = null; try { pv = prov(); } catch (_) {}
  if (pv && pv.underStation()) {
    const env = String(process.env.STARNET_AGENT_ID || '').trim();
    if (env && env !== id) throw new Refusal('this run is ' + nameOf(crew, env) + '\'s, not ' + nameOf(crew, id) + '\'s: --by names the seat running the command');
    const c = pv.callerConflict(S.root(), [TOOL, cmd], id);
    if (c) throw new Refusal('this command claims --by ' + nameOf(crew, id) + ' but ran in another seat\'s run (' + c.runId + ')');
  }
  return { kind: id === S.ceo() ? 'ceo' : co.holds(crew[id], 'people') ? 'people' : 'other', id, name: nameOf(crew, id) };
}
// the seat this process runs for (an agent's run), else null
const runSeat = () => { try { return prov().underStation() ? String(process.env.STARNET_AGENT_ID || '').trim() || null : null; } catch (_) { return null; } };

/* ---------------- pointers ---------------- */
const ROOTS = ['identity', 'temperament', 'convictions', 'willNotDo', 'unprompted', 'whereYouLook', 'flaws', 'strengths', 'blindSpots', 'habits', 'relationships', 'voice', 'examples', 'reminder', 'counterpart', 'boundaries', 'experiences', 'ownerNotes'];
const PROPOSABLE = ROOTS.filter(r => r !== 'ownerNotes' && r !== 'boundaries');
function parseSet(s) {
  const i = String(s).indexOf('='); if (i < 1) throw new Refusal('--set <pointer>=<json>, e.g. --set /temperament/risk=1');
  const ptr = s.slice(0, i).trim(), raw = s.slice(i + 1);
  let val; try { val = JSON.parse(raw); } catch (_) { val = raw; }
  return [ptr, val];
}
const toks = ptr => { if (!/^\/[A-Za-z]/.test(ptr)) throw new Refusal('a pointer starts with / and a field name: ' + ptr); return ptr.slice(1).split('/').map(t => t.replace(/~1/g, '/').replace(/~0/g, '~')); };
function setPointer(obj, ptr, val, allowed) {
  const t = toks(ptr);
  if (!(allowed || ROOTS).includes(t[0])) throw new Refusal('"' + t[0] + '" cannot be changed here' + (t[0] === 'model' ? ' (the model is set in Crew › Model)' : ''));
  let cur = obj;
  for (let i = 0; i < t.length - 1; i++) {
    const k = Array.isArray(cur) ? Number(t[i]) : t[i];
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = /^\d+$|^-$/.test(t[i + 1]) ? [] : {};
    cur = cur[k];
  }
  const last = t[t.length - 1];
  if (Array.isArray(cur)) { if (last === '-') cur.push(val); else if (/^\d+$/.test(last)) { if (val === null) cur.splice(Number(last), 1); else cur[Number(last)] = val; } else throw new Refusal('a list index is a number or -: ' + ptr); }
  else if (val === null && t.length > 1) delete cur[last]; else cur[last] = val;
  return obj;
}
function kindOf(ptrs) {
  const r = ptrs.map(p => toks(p)[0]);
  if (r.includes('temperament')) return 'temperament';
  if (r.includes('counterpart')) return 'counterpart';
  if (r.every(x => x === 'voice')) return 'voice';
  if (r.every(x => x === 'experiences')) return 'experience';
  return 'content';
}

/* ---------------- history (hash-chained) ---------------- */
const histFile = seat => P.paths(O()).history(seat);
function history(seat) {
  let t = ''; try { t = fs.readFileSync(histFile(seat), 'utf8'); } catch (_) { return []; }
  return t.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return { _bad: true }; } });
}
const rowHashOf = r => { const x = Object.assign({}, r); delete x.rowHash; return crypto.createHash('sha256').update(JSON.stringify(P.sortKeys(x))).digest('hex').slice(0, 16); };
function verifyChain(seat) {
  const rows = history(seat), problems = [];
  let prev = null, ver = 0;
  rows.forEach((r, i) => {
    if (r._bad) { problems.push('row ' + (i + 1) + ' is not JSON'); return; }
    if ((r.prevHash || null) !== prev) problems.push('row ' + (i + 1) + ' (version ' + r.version + ') does not follow the row before it: a row was removed or changed');
    if (rowHashOf(r) !== r.rowHash) problems.push('row ' + (i + 1) + ' (version ' + r.version + ') was edited after it was written');
    if (Number(r.version) <= ver) problems.push('row ' + (i + 1) + ' goes back to version ' + r.version);
    prev = r.rowHash; ver = Number(r.version) || ver;
  });
  return { ok: !problems.length, rows: rows.length, problems };
}
function appendHistory(seat, row) {
  const rows = history(seat), last = rows[rows.length - 1];
  const r = Object.assign({ at: new Date(S.now()).toISOString() }, row, { prevHash: last && last.rowHash ? last.rowHash : null });
  r.rowHash = rowHashOf(r);
  const f = histFile(seat), line = JSON.stringify(r) + '\n';
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, line);
  try { prov().appended(f, line, TOOL); } catch (_) {}
  return r;
}
const bodyAt = (seat, version) => { const r = history(seat).filter(x => !x._bad && Number(x.version) === Number(version)).pop(); return r && r.body ? clone(r.body) : null; };

/* ---------------- writing a profile ---------------- */
const ctxO = () => ({ crew: S.crew(), profiles: P.loadAll(O()), temperament: P.temperament(O()), root: S.root() });
function refreshModel(p) { const m = P.modelOf(p.seat, O()); p.model = m ? { provider: m.provider, model: m.model, effort: m.effort, note: 'set by models.js and hire.js remodel; shown here, not edited' } : null; return p; }
function charterFor(seat) { try { return require('./dossier.js').charterFile(S.crew()[seat] || {}, seat); } catch (_) { return null; } }
function renderCharterFile(p) {
  const f = charterFor(p.seat); if (!f || !fs.existsSync(f)) return null;
  const t = fs.readFileSync(f, 'utf8'); const r = P.renderCharter(t, p, ctxO());
  if (r.changed) writeAtomic(f, r.text);
  return r.changed ? path.relative(S.root(), f) : null;
}
function decisionLine(by, text, why) { try { return require('./decision.js').add({ by, text, why: why || undefined }); } catch (e) { return { error: e.message }; } }
function save(p, meta) {
  const crew = S.crew();
  refreshModel(p);
  p.hash = P.hashOf(p);
  const v = P.validate(p, { examplesAsNotes: true, crew });
  if (!v.ok) throw new Refusal('refused, the profile would not be valid: ' + v.problems.join('; '));
  const f = P.paths(O()).file(p.seat), text = JSON.stringify(p, null, 1) + '\n';
  writeAtomic(f, text);
  try { prov().wrote(f, text, TOOL); } catch (_) {}
  const h = appendHistory(p.seat, Object.assign({ version: p.version, by: meta.by, op: meta.op, kind: meta.kind, fields: meta.fields || [], body: p, why: clean(meta.why, 300) || null }, meta.decisionBy && meta.decisionBy !== meta.by ? { decidedBy: String(meta.decisionBy) } : {}));
  let charter = null, synced = null;
  if (P.policy(O()).inject === 'profile') {
    try { charter = renderCharterFile(p); } catch (_) {}
    // the station's copy of the seat's identity follows at once (dossier.js sync, in the background; the daily check catches a miss)
    if (!process.env.PROFILE_NO_SYNC) { try { const c = require('child_process').spawn(process.execPath, [path.join(__dirname, 'dossier.js'), 'sync', '--agent', p.seat], { cwd: S.root(), detached: true, stdio: 'ignore' }); c.unref(); synced = 'started'; } catch (_) { synced = null; } }
  }
  const dec = meta.decision === false ? null : decisionLine(meta.decisionBy || 'owner', 'Profile of ' + nameOf(crew, p.seat) + ': ' + meta.summary + ' (version ' + p.version + ', ' + meta.op + ').', meta.why ? clean(meta.why, 300) : undefined);
  return { version: p.version, hash: p.hash, notes: v.notes, charter, dossier: synced || undefined, historyRow: h.rowHash, decision: dec && dec.ok ? dec.id : undefined };
}
function current(seat) { const p = P.load(seat, O()); if (!p) throw new Refusal(nameOf(S.crew(), seat) + ' has no profile yet (profile.js migrate --seat ' + seat + ' --by <people seat>)'); return p; }
function casBase(p, base) {
  const b = Number(str(base)); if (!Number.isInteger(b) || b < 1) throw new Refusal('--base <version> is required (the version you are changing; show prints it)');
  if (b !== p.version) throw new Refusal('the profile is at version ' + p.version + ', not ' + b + ': someone changed it since you looked. Reload and make the change again.', 4, { conflict: true, version: p.version });
}
function applySets(p, sets, allowed) { const ptrs = []; for (const s of sets) { const [ptr, val] = Array.isArray(s) ? s : parseSet(s); setPointer(p, ptr, val, allowed); ptrs.push(ptr); } return ptrs; }
const ownerOnly = (a, cmd, seat) => {
  const rs = runSeat();
  if (rs && seat && rs === seat) throw new Refusal('no seat edits its own profile: the people function proposes changes (profile.js propose) and the owner decides');
  const who = actor(a.by, cmd);
  if (who.kind !== 'owner') throw new Refusal(who.id === seat ? 'no seat edits its own profile: the people function proposes changes (profile.js propose) and the owner decides' : 'only the owner changes a profile directly; the people function proposes (profile.js propose ' + (seat || '<seat>') + ' ...) and the owner or the CEO decides');
  return who;
};

function edit(a) {
  const seat = seatArg(a.pos[1]); ownerOnly(a, 'edit', seat);
  const p = current(seat); casBase(p, a.base);
  if (!a.set.length) throw new Refusal('nothing to change: --set <pointer>=<json>');
  if (p.trial) throw new Refusal('a trial is running (until ' + p.trial.until + '): keep it or stop it first (profile.js trial keep|stop ' + seat + ' --by owner)');
  const next = clone(p); const ptrs = applySets(next, a.set); const kind = kindOf(ptrs);
  if ((kind === 'temperament' || kind === 'counterpart') && a.now !== true) throw new Refusal('a ' + kind + ' change is tried first: use profile.js try ' + seat + ' ... (or --now to skip the trial)');
  next.version = p.version + 1; next.trial = null;
  const r = save(next, { by: 'owner', op: 'edit', kind, fields: ptrs, why: a.why, summary: 'the owner changed ' + ptrs.join(', ') + (a.now === true && (kind === 'temperament' || kind === 'counterpart') ? ' without a trial' : '') });
  return { code: 0, out: Object.assign({ ok: true, seat, kind, changed: ptrs }, r) };
}
function undo(a) {
  const seat = seatArg(a.pos[1]); ownerOnly(a, 'undo', seat);
  const p = current(seat); const to = Number(str(a.to));
  if (!Number.isInteger(to) || to < 1 || to >= p.version) throw new Refusal('--to <an earlier version> (now at ' + p.version + ')');
  const body = bodyAt(seat, to); if (!body) throw new Refusal('version ' + to + ' is not in the history');
  const next = Object.assign(body, { version: p.version + 1, trial: null });
  const r = save(next, { by: 'owner', op: 'undo', kind: 'content', fields: ['(all)'], why: a.why || 'back to version ' + to, summary: 'the owner went back to version ' + to });
  return { code: 0, out: Object.assign({ ok: true, seat, restored: to, sameAs: P.hashOf(next) === P.hashOf(body) }, r) };
}
function startTrial(p, sets, days, by, why, op, decisionBy) {
  const next = clone(p); const ptrs = applySets(next, sets); const kind = kindOf(ptrs);
  const d = Math.max(1, Math.min(60, Number(days) || Number(P.policy(O()).trial.days) || 7));
  next.version = p.version + 1;
  next.trial = { from: p.version, until: new Date(S.now() + d * DAY).toISOString(), startedBy: by, kind, fields: ptrs };
  const r = save(next, { by, op, kind, fields: ptrs, why, decisionBy, summary: 'a ' + d + '-day trial of ' + ptrs.join(', ') + ' started (it goes back to version ' + p.version + ' unless kept)' });
  return Object.assign({ ok: true, seat: p.seat, kind, changed: ptrs, trial: next.trial }, r);
}
function tryCmd(a) {
  const seat = seatArg(a.pos[1]); ownerOnly(a, 'try', seat);
  const p = current(seat); casBase(p, a.base);
  if (p.trial) throw new Refusal('a trial is already running (until ' + p.trial.until + '): keep it or stop it first');
  if (!a.set.length) throw new Refusal('nothing to try: --set <pointer>=<json>');
  return { code: 0, out: startTrial(p, a.set, a.days, 'owner', a.why, 'trial-start') };
}
function endTrial(p, keep, by, why, decisionBy) {
  const crew = S.crew();
  if (keep) {
    const next = clone(p); next.version = p.version + 1; next.trial = null;
    return save(next, { by, op: 'trial-keep', kind: p.trial.kind || 'content', fields: p.trial.fields || [], why, decisionBy, summary: 'the trial was kept: version ' + p.version + ' is now permanent' });
  }
  const body = bodyAt(p.seat, p.trial.from); if (!body) throw new Refusal('version ' + p.trial.from + ' is not in the history, so the trial cannot be undone; the owner edits the profile instead');
  const next = Object.assign(body, { version: p.version + 1, trial: null });
  return save(next, { by, op: 'trial-end', kind: p.trial.kind || 'content', fields: p.trial.fields || [], why, decisionBy, summary: nameOf(crew, p.seat) + ' went back to version ' + p.trial.from + ' (' + (why || 'the trial ended') + ')' });
}
function trial(a) {
  const sub = str(a.pos[1]); if (!['keep', 'stop'].includes(sub)) throw new Refusal('trial keep|stop <seat> --by owner');
  const seat = seatArg(a.pos[2]); ownerOnly(a, 'trial', seat);
  const p = current(seat); if (!p.trial) throw new Refusal(nameOf(S.crew(), seat) + ' has no trial running');
  const r = endTrial(p, sub === 'keep', 'owner', sub === 'keep' ? 'the owner kept it' : 'the owner stopped it');
  return { code: 0, out: Object.assign({ ok: true, seat, kept: sub === 'keep' }, r) };
}
// the dispatcher's step: a trial past its end with no answer goes back; one digest line for the owner, never a card
function tick(o) {
  o = o || {};
  const crew = S.crew(), done = [], now = S.now();
  for (const p of Object.values(P.loadAll(O()))) {
    if (!p.trial || !(Date.parse(p.trial.until) <= now)) continue;
    if (o.dry) { done.push({ seat: p.seat, wouldRevert: p.trial.from }); continue; }
    try {
      const people = co.seatFor('people');
      const r = endTrial(p, false, 'profile.js tick', 'the trial ended with no answer', nameOf(crew, people) || 'owner');
      done.push({ seat: p.seat, reverted: p.trial.from, version: r.version });
      try { require('./lib/governance').fyi({ from: nameOf(crew, people), text: 'The trial of a different ' + firstName(nameOf(crew, p.seat)) + ' ended without an answer, so ' + firstName(nameOf(crew, p.seat)) + ' is back to how they were. You can try it again on their Profile tab.', key: 'profile-trial:' + p.seat + ':' + p.version, technical: 'profile.js tick: ' + p.seat + ' version ' + p.version + ' (trial from ' + p.trial.from + ', until ' + p.trial.until + ') reverted to version ' + p.trial.from + ' as version ' + r.version }, O()); } catch (_) {}
    } catch (e) { done.push({ seat: p.seat, error: e.message }); }
  }
  return { ok: true, trials: done };
}

/* ---------------- proposals ---------------- */
const propFile = () => P.paths(O()).proposals;
const proposals = () => { const j = co.readJson(propFile(), null); return j && Array.isArray(j.proposals) ? j.proposals : []; };
function saveProposals(list) {
  const open = list.filter(x => x.status === 'open' || x.status === 'trial'), closed = list.filter(x => !(x.status === 'open' || x.status === 'trial')).slice(-200);
  const text = JSON.stringify({ _doc: 'the people function\'s proposed profile changes (profile.js propose / decide; docs/PROFILES.md); written only by profile.js', proposals: closed.concat(open) }, null, 1) + '\n';
  writeAtomic(propFile(), text); try { prov().wrote(propFile(), text, TOOL); } catch (_) {}
}
const KINDS = ['experience', 'voice', 'temperament', 'counterpart', 'content'];
function propose(a) {
  const seat = seatArg(a.pos[1]); const who = actor(a.by, 'propose');
  if (who.id === seat || runSeat() === seat) throw new Refusal('no seat proposes changes to its own profile; the people function does');
  if (who.kind !== 'owner' && !co.holds(S.crew()[who.id], 'people')) throw new Refusal('only the people function (' + (nameOf(S.crew(), co.seatFor('people')) || 'nobody yet') + ') proposes profile changes');
  const p = current(seat); const kind = str(a.kind); if (!KINDS.includes(kind)) throw new Refusal('--kind ' + KINDS.join('|'));
  const why = clean(a.why, 400); if (!why) throw new Refusal('--why ".." is required');
  const source = clean(a.source, 200) || null;
  const changes = {};
  if (kind === 'experience') {
    const text = clean(a.text, 400); if (!text && !a.set.length) throw new Refusal('an experience needs --text "<what happened and what they took from it>"');
    if (text) changes['/experiences/-'] = { at: co.localParts(new Date(S.now())).date, text, source: source || '', addedBy: who.kind === 'owner' ? 'owner' : who.name, version: p.version + 1 };
  }
  for (const s of a.set) { const [ptr, val] = parseSet(s); toks(ptr); if (!PROPOSABLE.includes(toks(ptr)[0])) throw new Refusal('"' + toks(ptr)[0] + '" is not something the people function proposes'); changes[ptr] = val; }
  if (!Object.keys(changes).length) throw new Refusal('nothing proposed: --set <pointer>=<json> (or --text for an experience)');
  const real = kindOf(Object.keys(changes)); if (real !== kind && !(kind === 'content' && real !== 'temperament' && real !== 'counterpart')) throw new Refusal('the changes are a ' + real + ' change, not ' + kind);
  // the change must make a valid profile
  { const t = clone(p); applySets(t, Object.entries(changes)); t.version = p.version + 1; refreshModel(t); t.hash = P.hashOf(t); const v = P.validate(t, { examplesAsNotes: true, crew: S.crew() }); if (!v.ok) throw new Refusal('the proposal would not make a valid profile: ' + v.problems.join('; ')); }
  const list = proposals();
  const dup = list.find(x => x.status === 'open' && x.seat === seat && JSON.stringify(x.changes) === JSON.stringify(changes));
  if (dup) return { code: 0, out: { ok: true, id: dup.id, duplicate: true } };
  const id = 'pp-' + crypto.randomBytes(4).toString('hex');
  list.push({ id, seat, by: who.kind === 'owner' ? 'owner' : who.id, at: new Date(S.now()).toISOString(), kind, changes, why, source, status: 'open', base: p.version });
  saveProposals(list);
  return { code: 0, out: { ok: true, id, seat, kind, next: 'the owner decides on the Profile tab, or the CEO at its level for profile changes (profile.js decide ' + id + ' apply|decline|try --by <CEO>)' } };
}
function govLevel() {
  const gov = require('./lib/governance');
  try {
    const g = gov.doc({ root: S.root() });
    if (g && g.categories && !Object.prototype.hasOwnProperty.call(g.categories, 'profiles')) {
      const def = co.readJson(path.join(S.root(), 'company', 'defaults', 'state', 'governance.json'), {}) || {};
      const v = def.categories && def.categories.profiles; if (['auto', 'notify', 'approve'].includes(v)) return v;
    }
    return gov.level('profiles', { root: S.root() });
  } catch (_) { return 'approve'; }
}
function decide(a) {
  const id = str(a.pos[1]), what = str(a.pos[2]);
  if (!/^pp-[0-9a-f]{8}$/.test(id) || !['apply', 'decline', 'try'].includes(what)) throw new Refusal('decide <pp-id> apply|decline|try --by <owner|CEO>');
  const who = actor(a.by, 'decide');
  if (who.kind !== 'owner' && who.kind !== 'ceo') throw new Refusal('the owner decides a profile proposal, or the CEO at its level for profile changes');
  const list = proposals(), pp = list.find(x => x.id === id);
  if (!pp) throw new Refusal('no proposal ' + id);
  if (pp.status !== 'open') throw new Refusal(id + ' is already ' + pp.status);
  if (who.id === pp.seat) throw new Refusal('no seat decides on its own profile');
  let lv = 'owner';
  if (who.kind === 'ceo') { lv = govLevel(); if (lv === 'approve' || lv === 'triage') throw new Refusal('profile changes are at "approve": the owner decides this one on ' + nameOf(S.crew(), pp.seat) + '\'s Profile tab', 3, { waiting: 'owner' }); }
  const crew = S.crew(), decidedBy = who.kind === 'owner' ? 'owner' : who.id, byName = who.kind === 'owner' ? 'owner' : who.name;
  let out;
  if (what === 'decline') { pp.status = 'declined'; out = { ok: true, id, declined: true }; }
  else {
    const p = current(pp.seat);
    if (p.trial) throw new Refusal(nameOf(crew, pp.seat) + ' has a trial running: it ends or is kept first');
    const goTrial = what === 'try' || pp.kind === 'temperament' || pp.kind === 'counterpart';
    const sets = Object.entries(pp.changes);
    if (goTrial) { out = startTrial(p, sets, a.days, decidedBy, 'proposal ' + id + ': ' + pp.why, 'trial-start', byName); pp.status = 'trial'; }
    else {
      const next = clone(p); const ptrs = applySets(next, sets); next.version = p.version + 1;
      for (const e of next.experiences || []) if (e && e.version === pp.base + 1 && e.version !== next.version) e.version = next.version;
      out = Object.assign({ ok: true, seat: pp.seat }, save(next, { by: pp.by === 'owner' ? 'owner' : pp.by, op: 'proposal-apply', kind: pp.kind, fields: ptrs, why: pp.why, decisionBy: byName, summary: 'applied ' + (pp.by === 'owner' ? 'the owner\'s' : nameOf(crew, pp.by) + '\'s') + ' proposal ' + id + ' (' + pp.kind + ')' }));
      pp.status = 'applied';
    }
    if (who.kind === 'ceo' && lv === 'notify') { try { require('./lib/governance').fyi({ from: who.name, text: who.name + ' approved a change to ' + firstName(nameOf(crew, pp.seat)) + '\'s profile that ' + firstName(nameOf(crew, pp.by)) + ' suggested. You can see it, and undo it, on their Profile tab.', key: 'profile-proposal:' + id, technical: 'profile.js decide ' + id + ' ' + what + ' by the CEO (governance profiles: notify)' }, O()); } catch (_) {} }
  }
  pp.decidedBy = decidedBy; pp.decidedAt = new Date(S.now()).toISOString();
  saveProposals(list);
  return { code: 0, out };
}

/* ---------------- hire.js: the new seat's first profile ---------------- */
// the hire's profile md (the charter headings, ## Counterpart naming a crew member, ## Example exchanges) as version 1,
// recorded as written by hire.js; an existing profile is left alone. Returns { version, missing } or { skipped }.
function fromHire(o) {
  const crew = S.crew(), seat = String(o.seat || '');
  if (!crew[seat]) throw new Refusal(seat + ' is not on the crew yet');
  if (P.load(seat, O())) return { skipped: 'already has a profile' };
  const r = P.fromCharter(String(o.md || ''), { seat, crew, root: S.root() });
  const p = r.profile; p.version = 1;
  if (p.counterpart && !crew[p.counterpart.seat]) p.counterpart = null;
  if (!p.reminder) p.reminder = P.reminder(p, { crew });
  const s = save(p, { by: 'hire.js', op: 'edit', kind: 'content', fields: ['(all)'], why: 'hired in round ' + (o.round || '?'), decisionBy: o.by || 'owner', summary: 'written at hire' + (r.missing.length ? '; still empty: ' + r.missing.join(', ') : ''), decision: o.decision });
  return { version: s.version, missing: r.missing, notes: s.notes };
}

/* ---------------- migrate, policy ---------------- */
function migrate(a) {
  const who = actor(a.by, 'migrate');
  if (who.kind !== 'owner' && !co.holds(S.crew()[who.id], 'people')) throw new Refusal('the people function or the owner builds profiles from the charters');
  const crew = S.crew(); const ids = a.all === true ? Object.keys(crew) : [seatArg(a.seat)];
  const made = [], skipped = [], reads = {};
  for (const seat of ids) {
    if (P.load(seat, O())) { skipped.push({ seat, why: 'already has a profile' }); continue; }
    const f = charterFor(seat); const md = f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    const r = P.fromCharter(md, { seat, crew, root: S.root() }); reads[seat] = r;
    const p = r.profile; p.version = 1;
    if (p.counterpart && !crew[p.counterpart.seat]) p.counterpart = null;
    if (!p.reminder) p.reminder = P.reminder(p, { crew });
    try { const s = save(p, { by: 'migrate', op: 'edit', kind: 'content', fields: ['(all)'], why: 'built from the charter by ' + (who.kind === 'owner' ? 'the owner' : who.name), decisionBy: who.kind === 'owner' ? 'owner' : who.name, summary: 'built from the charter' + (r.missing.length ? '; still empty: ' + r.missing.join(', ') : '') });
      made.push({ seat, version: s.version, missing: r.missing, notes: s.notes }); }
    catch (e) { skipped.push({ seat, why: e.message }); }
  }
  // what one charter alone cannot show (lib/profile.js crewChecks): a pairing the wrong way round, a seat named as the checker
  // of a seat that checks it, broken lines, identical sliders; for the people seat's fill-in round
  const cc = P.crewChecks(P.loadAll(O()), { crew });
  const forPeople = cc.failures.concat(cc.notes).filter(x => made.some(m => m.seat === x.seat) || ids.includes(x.seat)).map(x => x.text);
  for (const m of made) { const r2 = reads[m.seat]; if (r2 && r2.checks.length) m.checks = r2.checks; if (r2 && !r2.temperFromCharter) m.temperament = 'filled from the ' + (r2.profile.identity.archetype || 'role') + ' preset: the charter has no ## Temperament section'; }
  return { code: 0, out: { ok: true, made, skipped, problems: forPeople.length ? forPeople : undefined, next: made.length ? 'the people function fills what is still empty from each seat\'s own history (profile.js propose)' + (forPeople.length ? ', and fixes the problems listed' : '') : undefined } };
}
function policyCmd(a) {
  const sub = str(a.pos[1]);
  const pf = P.paths(O()).policy;
  if (!sub || sub === 'show') return { code: 0, out: Object.assign({ ok: true, file: path.relative(S.root(), pf) }, P.policy(O())) };
  ownerOnly(a, 'policy', null);
  const val = str(a.pos[2]); const cur = co.readJson(pf, null) || {};
  let summary;
  if (sub === 'inject') { if (!['charter', 'profile'].includes(val)) throw new Refusal('policy inject charter|profile'); cur.inject = val; summary = 'profiles ' + (val === 'profile' ? 'now shape every run' : 'no longer shape runs (the charter does, as before)'); }
  else if (sub === 'pov') { if (!['on', 'off'].includes(val)) throw new Refusal('policy pov on|off'); cur.pov = val === 'on'; summary = 'meetings ' + (val === 'on' ? 'now show each seat its own point of view' : 'are back to one transcript for everyone'); }
  else if (sub === 'signoff') { if (!['off', 'shadow', 'live'].includes(val)) throw new Refusal('policy signoff off|shadow|live'); cur.signoff = Object.assign({}, cur.signoff || {}, { mode: val }); summary = 'counterpart sign-off is ' + val; }
  else throw new Refusal('policy [show] | inject charter|profile | pov on|off | signoff off|shadow|live --by owner');
  const text = JSON.stringify(Object.assign({ _doc: 'this company\'s profile policy (docs/PROFILES.md); each missing field reads company/defaults/people/profile-policy.json; changed only through profile.js policy --by owner' }, cur), null, 1) + '\n';
  writeAtomic(pf, text); try { prov().wrote(pf, text, TOOL); } catch (_) {}
  const charters = [];
  if (sub === 'inject' && val === 'profile') for (const p of Object.values(P.loadAll(O()))) { try { const c = renderCharterFile(p); if (c) charters.push(c); } catch (_) {} }
  const dec = decisionLine('owner', 'Profiles: ' + summary + '.', a.why ? clean(a.why) : undefined);
  return { code: 0, out: { ok: true, policy: P.policy(O()), charters, decision: dec && dec.ok ? dec.id : undefined } };
}

/* ---------------- reading: show, list, render, check ---------------- */
const weekday = iso => { try { return new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: co.TZ }).format(new Date(iso)); } catch (_) { return String(iso).slice(0, 10); } };
const ADJ = { risk: ['bolder', 'more careful'], pace: ['faster', 'calmer'], rigour: ['more thorough', 'looser'], candour: ['blunter', 'gentler'], independence: ['more independent', 'more consultative'] };
// the owner's sentences for Crew › Profile (plain words: no ids, paths or model names)
function words(p) {
  const crew = S.crew(), me = firstName(p.identity.name || nameOf(crew, p.seat)), out = {};
  const c = p.counterpart;
  if (c && c.seat) { const k = (c.signOff || []).map(x => P.SIGNOFF_KINDS[x] && '**' + P.SIGNOFF_KINDS[x].owner + '**').filter(Boolean); const cn = firstName(nameOf(crew, c.seat));
    out.counterpart = '**Who checks ' + me + ':** ' + cn + '.' + (k.length ? ' Before ' + me + ' can ' + (k.length > 1 ? k.slice(0, -1).join(', ') + ' or ' + k[k.length - 1] : k[0]) + ', ' + cn + ' has to agree.' : ''); }
  else out.counterpart = 'Nobody checks ' + me + '\'s work before it moves on.';
  const checks = Object.values(P.loadAll(O())).filter(x => x.seat !== p.seat && x.counterpart && x.counterpart.seat === p.seat).map(x => firstName(nameOf(crew, x.seat)));
  if (checks.length) out.checks = me + ' checks ' + checks.join(' and ') + ' before their ideas move on.';
  if (p.trial) {
    const before = bodyAt(p.seat, p.trial.from); let adj = '';
    if (before && p.trial.kind === 'temperament') { let best = null; for (const k of P.TEMPER_KEYS) { const d = (p.temperament[k] || 0) - ((before.temperament || {})[k] || 0); if (d && (!best || Math.abs(d) > Math.abs(best.d))) best = { k, d }; } if (best) adj = ADJ[best.k][best.d > 0 ? 0 : 1]; }
    out.trial = 'You\'re trying ' + (adj ? 'a ' + adj + ' ' + me : p.trial.kind === 'counterpart' ? 'a new checker for ' + me : 'a change to ' + me) + ' until ' + weekday(p.trial.until) + '. Keep it · Go back now.';
  }
  const m = P.modelOf(p.seat, O()); out.model = m ? m.words : 'Runs on: the setup in Crew › Model';
  out.proposals = proposals().filter(x => x.seat === p.seat && x.status === 'open').map(x => {
    const by = x.by === 'owner' ? 'You' : firstName(nameOf(crew, x.by));
    const exp = x.changes['/experiences/-'];
    const line = exp ? by + (x.by === 'owner' ? ' suggested' : ' suggests') + ' adding to ' + me + '\'s experience: \'' + String(exp.text).replace(/\.$/, '') + '.\''
      : by + (x.by === 'owner' ? ' suggested' : ' suggests') + ' a change to ' + me + '\'s ' + ({ voice: 'voice', temperament: 'temperament', counterpart: 'checker', content: 'profile' }[x.kind] || 'profile') + ': ' + String(x.why).replace(/\.$/, '') + '.';
    return { id: x.id, kind: x.kind, text: line + ' Add it · Not this one · Try it.' };
  });
  out.family = familyNotes(P.loadAll(O())).filter(n => n.seats.includes(p.seat)).map(n => n.text);
  out.boundaries = P.FIXED_BOUNDARIES.map(b => b.plain);
  return out;
}
function isCode(seat, p) {
  try { const TC = require('./lib/taskclass'); if (TC.classOf({ text: '' }, seat, { departments: TC.departments({ root: S.root() }) }) === 'code') return true; } catch (_) {}
  return !!(p && p.identity && p.identity.archetype === 'builder');
}
function familyNotes(all) {
  if (P.policy(O()).familyCheck === 'off') return [];
  const crew = S.crew(), out = [];
  for (const p of Object.values(all)) {
    const c = p.counterpart; if (!c || !c.seat || !all[c.seat] && !crew[c.seat]) continue;
    const ma = P.modelOf(p.seat, O()), mb = P.modelOf(c.seat, O()); if (!ma || !mb) continue;
    const n = P.pairCheck({ seat: p.seat, name: nameOf(crew, p.seat), provider: ma.provider, model: ma.model, code: isCode(p.seat, p) }, { seat: c.seat, name: nameOf(crew, c.seat), provider: mb.provider, model: mb.model, code: isCode(c.seat, all[c.seat]) });
    if (n && !out.some(x => x.seats.slice().sort().join('|') === n.seats.slice().sort().join('|'))) out.push(n);
  }
  return out;
}
// the block as a Plain owner may see it (docs/TALK.md: a command or a file path never reaches a Plain owner): the crew's
// commands, file paths and handoff markup are named in words; the crew's own text is unchanged everywhere else
function ownerView(text) {
  return String(text || '')
    .replace(/\bnode\s+(?:company\/tools\/)?[\w\/.-]+\.js\b(?:\s+(?:[^\s.]|\.(?=\S))+)*/g, '(the crew\'s sign-off step)')
    .replace(/\*\*Needs sign-off:\*\*\s*<[^>]*>/g, 'a sign-off line')
    .replace(/(?:^|(?<=[\s("']))(?:\.\/)?(?:company|modules|console|scripts|docs)\/[\w\/.-]*[\w\/-]/g, '(a crew file)')
    .replace(/\s{2,}/g, ' ').replace(/ \n/g, '\n');
}
function preview(p) {
  const c = ctxO(); const ex = (p.examples || []).find(e => e.pushback) || (p.examples || [])[0] || null;
  let level = 'technical'; try { level = require('./lib/talk').prefs({ root: S.root() }).level; } catch (_) {}
  const block = P.block(p, c);
  return { block, ownerLevel: level, blockOwner: level === 'technical' ? block : ownerView(block), reminder: P.reminder(p, c), example: ex ? { who: ex.with === 'owner' ? 'You' : nameOf(c.crew, ex.with), they: ex.they, you: ex.you, pushback: !!ex.pushback, name: firstName(p.identity.name || nameOf(c.crew, p.seat)) } : null };
}
// who made a change, for the owner: You (the owner, also when the owner ran a build or a hire), a crew member's first
// name, or The crew (the tools' own steps); never a raw id
function personWords(by, crew) {
  const b = String(by || '');
  if (!b) return 'The crew';
  if (b === 'owner' || (() => { try { return require('./lib/owner').isOwnerName(b); } catch (_) { return false; } })()) return 'You';
  if (crew[b]) return firstName(nameOf(crew, b));
  const hit = Object.keys(crew).find(id => String((crew[id] || {}).name || '').toLowerCase() === b.toLowerCase());
  if (hit) return firstName(nameOf(crew, hit));
  // a candidate id from a hiring round (cand-<role>-<n>-<name>) or another tool's id: the person's first name when it is readable
  const m = b.match(/^cand-[a-z-]+?-\d+-([a-z]+)/i); if (m) return m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return /[\/._-]|^\w+\.js$/.test(b) ? 'The crew' : firstName(b);
}
function whoWords(r, crew) {
  const d = r.decidedBy || (r.by === 'owner' ? 'owner' : '');
  if (d) return personWords(d, crew);
  return r.by === 'migrate' || r.by === 'profile.js tick' || r.by === 'hire.js' ? 'The crew' : personWords(r.by, crew);
}
function show(a) {
  const seat = seatArg(a.pos[1]); const p = P.load(seat, O());
  if (!a.json && !a.console) { if (!p) return { code: 0, out: nameOf(S.crew(), seat) + ' has no profile yet.' }; return { code: 0, out: P.block(p, ctxO()) }; }
  if (!p) return { code: 0, out: { ok: true, seat, profile: null, name: nameOf(S.crew(), seat), canMigrate: true, policy: P.policy(O()) } };
  const out = { ok: true, seat, profile: p };
  if (a.console) {
    const crew = S.crew();
    const so = (() => { try { return require('./lib/signoff').list({ root: S.root() }).filter(x => x.override && x.from === seat).map(x => ({ at: x.at, by: x.override.by, op: 'sign-off override', why: x.override.why })); } catch (_) { return []; } })();
    out.history = history(seat).filter(r => !r._bad).slice(-30).reverse().map(r => ({ at: r.at, version: r.version, by: whoWords(r, crew), op: r.op, kind: r.kind, why: r.why })).concat(so);
    out.experiences = (p.experiences || []).map(e => Object.assign({}, e, { addedByName: personWords(e.addedBy, crew) }));
    out.proposals = proposals().filter(x => x.seat === seat && x.status === 'open');
    out.preview = preview(p); out.words = words(p); out.policy = P.policy(O());
    out.temperament = P.temperament(O()); out.signoffKinds = Object.fromEntries(Object.entries(P.SIGNOFF_KINDS).map(([k, v]) => [k, v.owner]));
    out.crew = Object.keys(crew).filter(s => s !== seat).map(s => ({ id: s, name: nameOf(crew, s) }));
    { const all = P.loadAll(O()); out.relations = { checks: Object.values(all).filter(x => x.seat !== seat && x.counterpart && x.counterpart.seat === seat).map(x => x.seat), manager: (crew[seat] || {}).manager || null, reports: Object.keys(crew).filter(s => (crew[s] || {}).manager === seat) }; }
    out.check = P.validate(p, { crew });
  }
  return { code: 0, out };
}
function render(a) {
  const seat = seatArg(a.pos[1]); let p = current(seat);
  if (a.set.length) { p = clone(p); applySets(p, a.set); }
  const c = ctxO();
  if (a.preview) return { code: 0, out: Object.assign({ ok: true, seat, check: P.validate(p, { examplesAsNotes: true, crew: c.crew }) }, preview(p)) };
  const text = a.reminder ? P.reminder(p, c) : a.charter ? P.charterSection(p, c) : P.block(p, c);
  return { code: 0, out: a.json ? { ok: true, seat, text } : text };
}
function list(a) {
  const crew = S.crew(), all = P.loadAll(O()), open = proposals().filter(x => x.status === 'open');
  const rows = Object.keys(crew).map(s => ({ seat: s, name: nameOf(crew, s), version: all[s] ? all[s].version : null, archetype: all[s] ? all[s].identity.archetype || null : null, counterpart: all[s] && all[s].counterpart ? all[s].counterpart.seat : null, trial: all[s] && all[s].trial ? all[s].trial.until : null, proposals: open.filter(x => x.seat === s).length }));
  if (a.json) return { code: 0, out: { ok: true, policy: P.policy(O()), seats: rows } };
  return { code: 0, out: rows.map(r => r.name + ' (' + r.seat + '): ' + (r.version ? 'version ' + r.version + (r.archetype ? ', ' + r.archetype : '') + (r.counterpart ? ', checked by ' + nameOf(crew, r.counterpart) : '') + (r.trial ? ', trial until ' + r.trial : '') + (r.proposals ? ', ' + r.proposals + ' proposal(s)' : '') : 'no profile')).join('\n') };
}
function check(a) {
  const crew = S.crew(), all = P.loadAll(O()), pol = P.policy(O());
  const seats = a.seat ? [seatArg(a.seat)] : a.all === true ? Object.keys(crew) : Object.keys(all);
  const report = [];
  for (const s of seats) {
    const p = all[s]; const fails = [], notes = [];
    if (!p) { notes.push('no profile yet (profile.js migrate --seat ' + s + ')'); report.push({ seat: s, failures: fails, notes }); continue; }
    const v = P.validate(p, { crew }); fails.push(...v.problems); notes.push(...v.notes);
    const ch = verifyChain(s); if (!ch.rows) fails.push('no history rows'); fails.push(...ch.problems);
    const last = history(s).filter(r => !r._bad).pop(); if (last && Number(last.version) !== p.version) fails.push('the profile is at version ' + p.version + ' but its history ends at ' + last.version + ' (written by something other than profile.js?)');
    if (pol.inject === 'profile') { const f = charterFor(s); if (f && fs.existsSync(f)) { const d = P.charterDrift(fs.readFileSync(f, 'utf8'), p, ctxO()); if (!d.markers) notes.push('the charter has no profile markers yet (the next change renders them)'); else if (d.drift) fails.push('the charter\'s profile section was edited by hand; the next render overwrites it (change the profile instead)'); } }
    report.push({ seat: s, version: p.version, failures: fails, notes });
  }
  const cc = P.crewChecks(all, { crew });
  for (const x of cc.failures) { const r = report.find(y => y.seat === x.seat); if (r) r.failures.push(x.text); }
  for (const x of cc.notes) { const r = report.find(y => y.seat === x.seat); if (r) r.notes.push(x.text); }
  const family = familyNotes(all).map(n => n.crew);
  const mix = P.crewMix(Object.values(all).map(p => ({ preset: (p.voice || {}).preset || (P.ARCHETYPES[(p.identity || {}).archetype] || {}).preset || '', archetype: (p.identity || {}).archetype || '' })));
  const bad = report.filter(r => r.failures.length);
  const out = { ok: !bad.length, seats: report, familyNotes: family, crew: mix };
  return { code: bad.length ? 1 : 0, out };
}

/* ---------------- the duty: experiences worth proposing ---------------- */
function duty() {
  const crew = S.crew(), all = P.loadAll(O()); if (!Object.keys(all).length) return { code: 0 };
  const since = S.now() - 7 * DAY, items = [];
  const used = new Set(); for (const p of Object.values(all)) for (const e of p.experiences || []) if (e && e.source) used.add(String(e.source));
  for (const x of proposals()) if (x.source) used.add(String(x.source));
  const names = Object.fromEntries(Object.keys(all).map(s => [s, [nameOf(crew, s), firstName(nameOf(crew, s))].map(n => new RegExp('\\b' + String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i'))]));
  const naming = t => Object.keys(names).filter(s => names[s].some(re => re.test(t)));
  const add = (src, text, seats) => { if (used.has(src)) return; for (const s of seats) items.push({ id: 'experience:' + s + ':' + src, route: 'people', text: 'consider an experience for ' + nameOf(crew, s) + ': ' + clean(text, 160) }); };
  let dec = ''; try { dec = fs.readFileSync(path.join(S.root(), 'company', 'work', 'decisions.md'), 'utf8'); } catch (_) {}
  for (const l of dec.split('\n')) {
    const m = l.match(/^- (\d{4}-\d{2}-\d{2})[ T][\d:]+ (.+?) \[(d-[0-9a-f]+)\] (.+)$/); if (!m || Date.parse(m[1] + 'T23:59:59Z') < since) continue;
    if (/^Profile of /.test(m[4])) continue;   // profile changes themselves are not experiences
    const who = naming(m[4]).filter(s => !names[s].some(re => re.test(m[2]))); if (who.length) add(m[3], m[4], who);
  }
  let corr = ''; try { corr = fs.readFileSync(path.join(S.root(), 'company', 'work', 'people', 'corrections-log.jsonl'), 'utf8'); } catch (_) {}
  for (const l of corr.split('\n')) { let r = null; try { r = JSON.parse(l); } catch (_) { continue; } if (!r || r.event !== 'added' || !all[r.agentId] || Date.parse(String(r.at).replace(' ', 'T')) < since) continue; add('correction:' + r.id, 'a correction: ' + (r.title || r.issueClass || ''), [r.agentId]); }
  const rul = co.readJson(path.join(S.root(), 'company', 'state', 'owner-rulings.json'), {}) || {};
  for (const r of Array.isArray(rul.rulings) ? rul.rulings : []) { if (!r || !r.id || Date.parse(r.at || '') < since) continue; add('ruling:' + r.id, 'an owner ruling: ' + r.text, naming(String(r.text || ''))); }
  let inc = []; try { inc = fs.readdirSync(path.join(S.root(), 'company', 'work', 'incidents')).filter(f => /\.md$/.test(f)); } catch (_) {}
  for (const f of inc) { const fp = path.join(S.root(), 'company', 'work', 'incidents', f); let st; try { st = fs.statSync(fp); } catch (_) { continue; } if (st.mtimeMs < since) continue; const t = fs.readFileSync(fp, 'utf8').slice(0, 20000); add('incident:' + f, 'an incident: ' + (t.match(/^# (.+)$/m) || [, f])[1], naming(t)); }
  if (!items.length) return { code: 0 };
  const key = crypto.createHash('sha256').update(items.map(i => i.id).sort().join('\n')).digest('hex').slice(0, 16);
  return { code: 1, out: { due: true, route: 'people', key, items: items.slice(0, 40), reason: (items.length + ' recent event(s) name a crew member and may deserve an experience line in their profile: propose one with profile.js propose <seat> --kind experience --text ".." --source <the id> --why ".." (or skip it; the item is gone once a proposal or an experience cites that source)').slice(0, 300) } };
}

/* ---------------- main ---------------- */
function main(argv) {
  const a = args(argv), cmd = a.pos[0] || 'list';
  if (argv.length === 1 && argv[0] === '--duty') return duty();
  const T = { show, list, check, render, edit, undo, try: tryCmd, trial, propose, decide, migrate, policy: policyCmd };
  if (cmd === 'tick') return { code: 0, out: tick({ dry: a.dry === true }) };
  if (T[cmd]) return T[cmd](a);
  throw new Refusal('usage: profile.js show|list|check|render|edit|undo|try|trial|tick|propose|decide|migrate|policy (see the header) | --duty | --selftest');
}
function run(argv) {
  try { return main(argv); }
  catch (e) { if (e instanceof Refusal) return { code: e.code, out: Object.assign({ ok: false, refused: true, error: e.message }, e.extra) }; return { code: 1, out: { ok: false, error: String(e && e.stack || e) } }; }
}

/* ---------------- selftest: the pure parts (the CLI: tests/profile*.test.js) ---------------- */
function selftest() {
  let bad = 0; const ok = (n, c, d) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : '  [' + String(d || '').slice(0, 300) + ']')); if (!c) bad++; };
  const crew = { ben: { name: 'Benny Tran' }, ro: { name: 'Rohan Iyer' } };
  const p = P.blank('ben', { name: 'Benny Tran', title: 'Idea Scout' }); p.identity.archetype = 'scout'; p.counterpart = { seat: 'ro', signOff: ['promote'], why: 'tests every card' };
  p.examples = [{ with: 'ro', they: 'a', you: 'b', pushback: true }, { with: 'owner', they: 'c', you: 'd' }, { with: 'ro', they: 'e', you: 'f' }]; p.hash = P.hashOf(p);
  ok('a full blank profile with a counterpart validates', P.validate(p, { crew }).ok, JSON.stringify(P.validate(p, { crew })));
  const b1 = P.block(p, { crew }), q = clone(p); q.ownerNotes = 'private'; q.version = 9; q.trial = { from: 8, until: '2027-01-01T00:00:00Z' };
  ok('block: owner notes, version and trial do not change it', P.block(q, { crew }) === b1 && !/private/.test(P.block(q, { crew })));
  ok('reminder: at most 200 characters', P.reminder(Object.assign(clone(p), { reminder: 'x '.repeat(200) })).length <= 200);
  ok('a reminder over 200 characters is refused', !P.validate(Object.assign(clone(p), { reminder: 'y'.repeat(201), hash: '' })).ok);
  const nb = clone(p); nb.boundaries = nb.boundaries.slice(1); nb.hash = '';
  ok('a fixed boundary cannot be removed', !P.validate(nb).ok);
  ok('pointers: set, append and kind', (() => { const x = clone(p); setPointer(x, '/temperament/risk', 1); setPointer(x, '/convictions/-', 'c'); return x.temperament.risk === 1 && x.convictions[0] === 'c' && kindOf(['/voice/words']) === 'voice' && kindOf(['/temperament/risk', '/voice/words']) === 'temperament'; })());
  ok('pointers: the model block cannot be set', (() => { try { setPointer(clone(p), '/model/provider', 'x'); return false; } catch (e) { return /cannot be changed/.test(e.message); } })());
  ok('family: same kind of model on an opposed pair is a note; a code pair is not', !!P.pairCheck({ seat: 'ben', provider: 'deepseek', model: 'deepseek-flash' }, { seat: 'ro', provider: 'deepseek', model: 'deepseek-pro' }) && !P.pairCheck({ seat: 'ben', provider: 'claude-cli', model: 'x', code: true }, { seat: 'ro', provider: 'claude-cli', model: 'y' }));
  ok('familyOf: openrouter by the model\'s vendor', P.familyOf('openrouter', 'anthropic/claude-x') === 'anthropic' && P.familyOf('custom', 'MiniMax-M3') === 'minimax');
  const ch = P.renderCharter('# B\n\n## Scope\ns\n\n## Convictions\nold\n\n## KPIs\nk\n', p, { crew }).text;
  ok('charter: the person sections move inside the markers; the rest is untouched', /<!-- profile:begin v=1 -->[\s\S]*<!-- profile:end -->/.test(ch) && /## Scope\ns/.test(ch) && /## KPIs\nk/.test(ch) && !/old/.test(ch));
  ok('charter: a hand edit inside the markers is seen', P.charterDrift(ch.replace('## Archetype\nscout', '## Archetype\nlead'), p, { crew }).drift && !P.charterDrift(ch, p, { crew }).drift);
  const back = P.fromCharter(ch, { seat: 'ben', crew }).profile;
  ok('fromCharter reads back the counterpart and the examples', back.counterpart && back.counterpart.seat === 'ro' && back.examples.length === 3 && back.examples[0].pushback === true, JSON.stringify(back.counterpart));
  console.log(bad ? 'PROFILE SELFTEST FAILED: ' + bad : 'PROFILE SELFTEST PASSED');
  return bad ? 1 : 0;
}

module.exports = { ownerView, run, tick, fromHire, Refusal, _S: S, verifyChain, history, words, setPointer, kindOf };
if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--selftest' || argv[0] === 'selftest') process.exit(selftest());
  const r = run(argv);
  if (r.out !== undefined) console.log(typeof r.out === 'string' ? r.out : JSON.stringify(r.out, null, 1));
  process.exit(r.code);
}
