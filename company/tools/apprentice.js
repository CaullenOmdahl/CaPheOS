#!/usr/bin/env node
'use strict';
/* apprentice.js — the apprentice model shadows real work (docs/APPRENTICE.md). The apprentice is the owner's own
 * experimental self-learning model server: an untrusted intern. It never runs as one of our agents (no seat, no station
 * run, no tools, no shell, no writes), its answers are never used for company work, it runs for the sandbox company
 * only, and it never approves its own learning: this tool is the external approver.
 *
 *   node company/tools/apprentice.js status [--json]                 switch, guards, today's count, last decisions, scores
 *   node company/tools/apprentice.js config [--json]                 the config in force (defaults + the owner's file)
 *   node company/tools/apprentice.js shadow --once [--dry-run]       one shadow pass now (dry run: what would go, no network)
 *   node company/tools/apprentice.js study --once [--seed N]         one study -> bench -> promote/rollback cycle now
 *   node company/tools/apprentice.js promote-gate --live <f> --candidate <f> [--tolerance N]   the decision on two results
 *   node company/tools/apprentice.js tick                            what the dispatcher starts (detached): guards, lock,
 *                                                                    a shadow pass when due, a study cycle when due
 *   node company/tools/apprentice.js enable --by owner               the owner's switch (off by default)
 *   node company/tools/apprentice.js disable --by <anyone>           the kill switch: anyone may turn it off
 *   node company/tools/apprentice.js configure --by owner [--base-url U] [--namespace N] [--tenant T] [--key-secret S]
 *                                              [--daily-cap N] [--per-tick-cap N]
 *   node company/tools/apprentice.js --selftest                      a stub server on 127.0.0.1, a fixture company
 *
 * The flow: a production job whose result passed validation (model-rank.js analyze(): settled, oneShot 1, hard) is sent
 * to the apprentice as a bench-shaped task: the job's own text, a snapshot of what the production run read (its
 * transcript's read tool results), no tools, one answer. The answer is scored against the production answer with the
 * model bench's own scorers (kinds 1, 2 and 5 at lookup and simple, configurable) and the whole (task, teacher answer,
 * apprentice answer, score) goes to the apprentice's trajectories endpoint as a lesson. On its schedule (quiet hours) the
 * tool asks the apprentice to study; each candidate unit it produces is benched against the live version (same seed,
 * same repeat) through a direct client, and promoted only when the score rises and no (kind, depth) gets worse, else
 * rolled back. Every decision is logged. Shadow scores per (kind, depth) are written as
 * company/state/model-bench/<model>.shadow.json (schema model-bench-shadow/1, source shadow), the bench result as a
 * model-bench/1 file with routable:false. Nothing the apprentice returns is written to a company file: only scores.
 *
 * Switch and config: company/state/apprentice.json, trusted only as the owner's own recorded write (enable / configure
 * from the owner's shell or the console, like model-bench.js limits); absent, hand-edited or a seat's write = off and
 * defaults. Defaults: company/defaults/state/apprentice.json. Key: secrets/<keySecret>. Runs only when the switch is on,
 * this company is the sandbox (lib/selfimprove.js isSandbox), the key and baseUrl exist, and no other pass holds the lock.
 * State and logs: company/state/apprentice/ (state.json, shadow.jsonl, decisions.jsonl, log.jsonl; bounded, retention).
 * Exit: 0 done, 1 selftest failed or a step failed, 2 usage, 3 refused (off, not the sandbox, no key, locked).
 * Owner: the people function.
 */
if (process.argv.includes('--selftest')) process.env.CAPHEOS_TZ = 'UTC';   // before lib/company.js reads it
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const co = require('./lib/company');

const CONFIG_REL = 'company/state/apprentice.json';
const DEFAULTS_REL = 'company/defaults/state/apprentice.json';
const FRAMEWORK_DEFAULTS = path.join(__dirname, '..', 'defaults', 'state', 'apprentice.json');
const OWNER_WRITERS = ['company/tools/apprentice.js', 'console/server.js'];
const WRITER = 'apprentice.js';

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const rootOf = o => path.resolve((o && o.root) || co.ROOT);
const sdir = root => path.join(root, 'company', 'state', 'apprentice');
const shaOf = t => 'sha256:' + crypto.createHash('sha256').update(t).digest('hex');
const bump = (o, k, n) => { o[k] = (o[k] || 0) + (n || 1); };
const isPlain = x => x && typeof x === 'object' && !Array.isArray(x);
function merge(a, b) { const out = Object.assign({}, a); for (const [k, v] of Object.entries(b || {})) out[k] = isPlain(v) && isPlain(out[k]) ? merge(out[k], v) : v; return out; }
const localDate = now => co.localParts(new Date(now)).date;
const slug = m => String(m).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);

/* ---------------- config: defaults + the owner's recorded file ---------------- */
function defaults(root) { return readJson(path.join(root, DEFAULTS_REL), null) || readJson(FRAMEWORK_DEFAULTS, {}) || {}; }
function ownerFile(root, o) {
  if (o && isPlain(o.configOverride)) return { conf: o.configOverride, trusted: true, why: null };   // tests only (in-process)
  const f = path.join(root, CONFIG_REL);
  let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch (_) { return { conf: null, trusted: false, why: 'no owner config (off)' }; }
  let rec = null;
  try { for (const r of require('./lib/owner-channel')._lib.provRows(root, CONFIG_REL, true)) if (r.kind === 'write') rec = r; } catch (_) {}
  if (!rec) return { conf: null, trusted: false, why: 'the apprentice config has no recorded write, so it is not the owner\'s (off)' };
  if (rec.sha256 !== shaOf(txt)) return { conf: null, trusted: false, why: 'the apprentice config was changed after the owner\'s recorded write (off)' };
  if (rec.underStation !== false || rec.tainted === true) return { conf: null, trusted: false, why: 'the apprentice config was written from an agent\'s run (off)' };
  if (!OWNER_WRITERS.includes(require('./lib/pm-inbox-guard').mainRel(rec.main)) || !(rec.writer === WRITER || /^console\b/.test(String(rec.writer || '')))) return { conf: null, trusted: false, why: 'the apprentice config was not written by apprentice.js or the console (off)' };
  const d = readJson(f, null);
  return isPlain(d) ? { conf: d, trusted: true, why: null } : { conf: null, trusted: false, why: 'the apprentice config is not valid json (off)' };
}
function config(root, o) {
  const d = defaults(root), of = ownerFile(root, o);
  const c = merge(d, of.trusted ? of.conf : {});
  c.enabled = !!(of.trusted && of.conf && of.conf.enabled === true);
  c.trusted = of.trusted; c.why = of.why;
  c.shadow = c.shadow || {}; c.study = c.study || {};
  return c;
}
const liveModel = cfg => require('./lib/apprentice/adapter').modelId(cfg);
const label = cfg => String(cfg.provider || 'apprentice') + '/' + liveModel(cfg);
function secretAt(root, name) {
  if (!name || !/^[A-Za-z0-9._-]{1,80}$/.test(name)) return null;
  const env = process.env['CAPHEOS_SECRET_' + name.toUpperCase().replace(/[^A-Z0-9]/g, '_')];
  if (env) return env.trim();
  try { return fs.readFileSync(path.join(root, 'secrets', name), 'utf8').trim() || null; } catch (_) { return null; }
}
function isSandbox(root, o) {
  if (o && typeof o.isSandbox === 'function') return !!o.isSandbox(root);
  try { return require('./lib/selfimprove').isSandbox(root); } catch (_) { return false; }
}
function guards(root, cfg, o) {
  const why = [];
  if (!cfg.enabled) why.push(cfg.why || 'the apprentice is off (apprentice.js enable --by owner)');
  if (!isSandbox(root, o)) why.push('this company is not the sandbox company (company/state/selfimprove.json sandboxRoot)');
  if (!cfg.baseUrl) why.push('no baseUrl in the apprentice config');
  if (!secretAt(root, cfg.keySecret)) why.push('no key (secrets/' + (cfg.keySecret || '?') + ')');
  return { ok: !why.length, why };
}

/* ---------------- state, logs, lock ---------------- */
const STATE_DEF = () => ({ v: 1, days: {}, done: {}, waiting: {}, refused: {}, decided: {}, lastShadowAt: 0, lastStudyAt: 0, lastStudyTryAt: 0 });
function loadState(root) { const s = readJson(path.join(sdir(root), 'state.json'), null); return isPlain(s) ? Object.assign(STATE_DEF(), s) : STATE_DEF(); }
function saveState(root, st) {
  const keepDone = 5000, keys = Object.keys(st.done);
  if (keys.length > keepDone) { const old = keys.sort((a, b) => (st.done[a].at || 0) - (st.done[b].at || 0)).slice(0, keys.length - keepDone); for (const k of old) delete st.done[k]; }
  const days = Object.keys(st.days).sort(); for (const d of days.slice(0, Math.max(0, days.length - 14))) delete st.days[d];
  const f = path.join(sdir(root), 'state.json'); fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(st, null, 1) + '\n'); fs.renameSync(tmp, f);
}
function appendLog(root, name, row, cfg) {
  const f = path.join(sdir(root), name + '.jsonl'); fs.mkdirSync(path.dirname(f), { recursive: true });
  const cap = Number(cfg && cfg.maxLogBytes) || 4 * 1024 * 1024;
  try { if (fs.statSync(f).size > cap) fs.renameSync(f, f + '.1'); } catch (_) {}
  const now = Date.now();
  fs.appendFileSync(f, JSON.stringify(Object.assign({ at: new Date(now).toISOString(), ts: now }, row)) + '\n');
}
function tailRows(root, name, maxBytes) {
  const B = require('./lib/bounded');
  const out = [];
  for (const l of B.tailText(path.join(sdir(root), name + '.jsonl'), maxBytes || 4 * 1024 * 1024).split('\n')) { if (!l.trim()) continue; try { const r = JSON.parse(l); if (r && !r._retention) out.push(r); } catch (_) {} }
  return out;
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const lockFile = root => path.join(sdir(root), 'lock');
function lockHeld(root) {
  const l = readJson(lockFile(root), null); if (!l) return false;
  return alive(Number(l.pid)) && Date.now() < (Number(l.until) || 0) + 60e3;
}
function takeLock(root, budgetMs) {
  const f = lockFile(root); fs.mkdirSync(path.dirname(f), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(f, 'wx'); const me = { pid: process.pid, at: Date.now(), until: Date.now() + budgetMs, token: crypto.randomBytes(6).toString('hex') };
      fs.writeSync(fd, JSON.stringify(me)); fs.closeSync(fd);
      return () => { const l = readJson(f, null); if (l && l.token === me.token) try { fs.unlinkSync(f); } catch (_) {} };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (lockHeld(root)) return null;
      try { fs.unlinkSync(f); } catch (_) {}   // its holder ended or ran past its budget
    }
  }
  return null;
}

/* ---------------- schedule ---------------- */
function shadowDue(cfg, st, now) {
  const sh = cfg.shadow, used = (st.days[localDate(now)] || {}).shadowed || 0;
  return used < (Number(sh.dailyCap) || 20) && now - (Number(st.lastShadowAt) || 0) >= (Number(sh.everyMin) || 60) * 60e3;
}
function studyDue(cfg, st, now) {
  const s = cfg.study, h = co.localParts(new Date(now)).hour, from = Number(s.hourLocal == null ? 3 : s.hourLocal), span = Math.max(1, Number(s.quietHours) || 3);
  const inQuiet = ((h - from + 24) % 24) < span;
  // a failed try (the server away) waits an hour before the next, so the quiet hours are not one try per dispatcher tick
  return inQuiet && now - (Number(st.lastStudyAt) || 0) >= (Number(s.everyHours) || 24) * 3600e3 - 30 * 60e3 && now - (Number(st.lastStudyTryAt) || 0) >= 3600e3;
}
/* cheap and fail-safe: the dispatcher calls it every tick. False unless the switch is on (the owner's recorded write),
   this is the sandbox, the key and baseUrl exist, no pass holds the lock, and a shadow pass or a study cycle is due. */
function due(o) {
  try {
    o = o || {};
    const root = rootOf(o);
    if (!o.configOverride) { const raw = readJson(path.join(root, CONFIG_REL), null); if (!raw || raw.enabled !== true) return false; }
    const cfg = config(root, o);
    if (!guards(root, cfg, o).ok || lockHeld(root)) return false;
    const st = loadState(root), now = Number(o.now) || Date.now();
    return shadowDue(cfg, st, now) || studyDue(cfg, st, now);
  } catch (_) { return false; }
}

/* ---------------- the bench unit ---------------- */
function unitFor(root, o) {
  if (o && o.unit) return o.unit;
  return require('./model-bench.js').unitDir(root);
}
const benchLib = dir => require(path.join(dir, 'lib', 'bench.js'));

/* ---------------- collecting validated work ---------------- */
function collect(root, now) {
  const M = require('./model-rank.js');
  const inp = M.load({ root, now });
  if (!inp) return { items: [], wakeById: new Map(), runById: new Map(), secByKey: new Map(), why: 'no ranking policy' };
  const an = M.analyze(inp);
  const secByKey = new Map(); for (const s of M.sectionsOf(inp.files)) { const k = s.file + '\n' + s.id; if (!secByKey.has(k)) secByKey.set(k, s); }
  return { items: an.items, wakeById: an.wakeById, runById: an.runById, secByKey };
}
function resolvedText(sec) {
  const lines = String(sec || '').split('\n'); const i = lines.findIndex(l => /^\*\*Resolved\b/.test(l)); if (i < 0) return '';
  return [lines[i].replace(/^\*\*Resolved[^*]*\*\*\s*[—:-]?\s*/, '')].concat(lines.slice(i + 1)).join('\n').trim();
}
function wakeOf(it, C) {
  const ws = (it.wakes || []).map(id => C.wakeById.get(id)).filter(Boolean);
  return ws.filter(w => w.route).pop() || ws.pop() || null;
}

/* ---------------- the shadow pass ---------------- */
async function shadowPass(root, cfg, o) {
  o = o || {};
  const L = require('./lib/apprentice/lessons');
  const now = Number(o.now) || Date.now(), sh = cfg.shadow, st = loadState(root), day = localDate(now);
  st.days[day] = st.days[day] || { shadowed: 0 };
  const left = Math.max(0, Math.min(Number(sh.perTickCap) || 5, (Number(sh.dailyCap) || 20) - st.days[day].shadowed));
  const res = { day, shadowed: 0, scored: 0, passed: 0, posted: 0, skipped: {}, dry: !!o.dryRun, planned: [] };
  const deadline = Date.now() + (Number(cfg.wallBudgetMin) || 10) * 60e3;
  if (!left) { bump(res.skipped, 'cap'); if (!o.dryRun) appendLog(root, 'log', { event: 'shadow', note: 'daily cap reached', cap: sh.dailyCap }, cfg); return res; }
  const C = collect(root, now);
  const el = L.eligible(C.items, cfg, st.done);
  for (const [k, n] of Object.entries(el.skipped)) if (k !== 'done' && k !== 'settling' && k !== 'excluded') bump(res.skipped, k, n);
  const unit = unitFor(root, o);
  const client = o.dryRun ? null : (o.client || require('./lib/apprentice/client').makeClient({ root, cfg, key: secretAt(root, cfg.keySecret) }));
  const markDone = (it, outcome) => { st.done[it.key] = { at: now, outcome }; delete st.waiting[it.key]; };
  const skip = (it, reason, extra) => { bump(res.skipped, reason); markDone(it, reason); if (!o.dryRun) appendLog(root, 'shadow', Object.assign({ item: it.key, runId: it.runId, outcome: 'skipped', reason }, extra || {}), cfg); };
  let lookups = 0; const segCache = new Map();
  const maxLookups = Number(sh.maxLookupsPerPass) || 40;   // transcript reads per pass: the rest wait for the next pass
  for (const it of el.take) {
    if (res.shadowed >= left) { bump(res.skipped, 'cap'); continue; }
    if (lookups >= maxLookups) { bump(res.skipped, 'next-pass'); continue; }
    if (Date.now() > deadline) { res.stopped = 'budget'; break; }
    if (!o.dryRun && !config(root, o).enabled) { res.stopped = 'switched off'; break; }   // the kill switch, between items
    const run = C.runById.get(String(it.runId));
    if (!run) { skip(it, 'no-run'); continue; }
    const tr = L.transcript(root, run, cfg, now, segCache); lookups++;
    if (tr.state === 'waiting') { bump(res.skipped, 'waiting-transcript'); if (!st.waiting[it.key]) st.waiting[it.key] = now; continue; }
    if (tr.state === 'none') { skip(it, 'no-transcript'); continue; }
    const tar = L.teacherAndReads(tr.rows, String(it.runId), cfg);
    const sec = C.secByKey.get(it.key) || { text: '' };
    const teacher = tar.teacher || resolvedText(sec.text) || String(run.deliveryText || '');
    const facts = L.facts(teacher, cfg);
    const kd = L.kindDepth({ item: it, sec: sec.text, wake: wakeOf(it, C), cfg, facts });
    if (kd.skip) { skip(it, kd.skip, { why: kd.why }); continue; }
    if (facts.length < (Number(sh.minFacts) || 1)) { skip(it, 'teacher-unstructured'); continue; }
    const ex = L.toExpected(kd.kind, facts);
    if (!ex) { skip(it, 'teacher-unstructured'); continue; }
    const ins = L.instructions(sec.text, facts);
    if (!ins.text) { skip(it, 'no-instructions'); continue; }
    const prompt = L.promptFor(unit.dir, kd.kind, ins.text, ex.ask, tar.files);
    if (o.dryRun) { res.planned.push({ item: it.key, kind: kd.kind, depth: kd.depth, why: kd.why, facts: facts.length, reads: tar.reads, readBytes: tar.bytes, promptChars: prompt.length }); res.shadowed++; continue; }
    const t0 = Date.now();
    let ans;
    try { ans = await client.chat(liveModel(cfg), [{ role: 'user', content: prompt }], { purpose: 'shadow' }); }
    catch (e) { res.error = String(e.message || e).slice(0, 200); appendLog(root, 'log', { event: 'shadow', error: res.error }, cfg); break; }   // server away: try again next time
    const timeSec = Math.round((Date.now() - t0) / 100) / 10;
    const sc = await L.score(unit.dir, kd.kind, ans.text, ex.expected);
    const lesson = { kind: 'lesson', task: { instructions: ins.text, files: tar.files, prompt }, teacher: { answer: teacher, model: it.cell && it.cell.model },
      student: { answer: ans.text }, score: sc.score, pass: sc.pass, benchKind: kd.kind, depth: kd.depth, source: { item: it.key, runId: it.runId }, at: new Date(now).toISOString() };
    let posted = false, postStatus = null;
    try { const r = await client.submitTrajectory(lesson); postStatus = r.status; posted = r.status >= 200 && r.status < 300; } catch (e) { postStatus = 'error'; }
    st.days[day].shadowed++; res.shadowed++; res.scored++; if (sc.pass) res.passed++; if (posted) res.posted++;
    markDone(it, 'scored');
    // scores only: the apprentice's own words never go into a company file
    appendLog(root, 'shadow', { item: it.key, runId: it.runId, outcome: 'scored', kind: kd.kind, depth: kd.depth, why: kd.why, pass: sc.pass, score: sc.score, failure: sc.failure || null,
      timeSec, facts: facts.length, reads: tar.reads, readBytes: tar.bytes, tainted: tar.tainted, droppedLines: ins.dropped, teacherModel: it.cell && it.cell.model, posted, postStatus }, cfg);
  }
  // an item whose transcript never came within maxWaitDays is dropped (never a failure)
  const maxWait = (Number(sh.maxWaitDays) || 3) * 864e5;
  for (const [k, at] of Object.entries(st.waiting)) if (now - at > maxWait) { st.done[k] = { at: now, outcome: 'no-transcript' }; delete st.waiting[k]; }
  if (!o.dryRun) {
    st.lastShadowAt = now; saveState(root, st);
    if (res.scored) writeShadowSummary(root, cfg);
    appendLog(root, 'log', { event: 'shadow', shadowed: res.shadowed, passed: res.passed, posted: res.posted, skipped: res.skipped, stopped: res.stopped || null }, cfg);
  }
  return res;
}

/* the shadow scores per (kind, depth): what a routing build can read as this model's live record, marked shadow */
const p50 = xs => { if (!xs.length) return 0; const s = xs.slice().sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };
function shadowSummary(rows, model) {
  const cells = {};
  for (const r of rows) {
    if (r.outcome !== 'scored' || !r.kind || !r.depth) continue;
    const c = cells[r.kind + '|' + r.depth] || (cells[r.kind + '|' + r.depth] = { kind: Number(r.kind), depth: r.depth, n: 0, passed: 0, scores: [], times: [] });
    c.n++; if (r.pass) c.passed++; c.scores.push(Number(r.score) || 0); c.times.push(Number(r.timeSec) || 0);
  }
  const kinds = {}, live = [];
  for (const c of Object.values(cells).sort((a, b) => a.kind - b.kind || (a.depth < b.depth ? -1 : 1))) {
    const k = kinds[String(c.kind)] || (kinds[String(c.kind)] = { levels: {} });
    const t = p50(c.times);
    k.levels[c.depth] = { n: c.n, passed: c.passed, passRate: Math.round(c.passed / c.n * 1000) / 1000, scoreMean: Math.round(c.scores.reduce((a, b) => a + b, 0) / c.n * 1000) / 1000, timeSecP50: t };
    live.push({ model, kind: c.kind, depth: c.depth, n: c.n, oneShot: c.passed, timeSecP50: t });
  }
  return { schema: 'model-bench-shadow/1', model, source: 'shadow', routable: false, at: new Date().toISOString(), kinds, live };
}
function writeLocked(file, txt, root) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid; fs.writeFileSync(tmp, txt); fs.renameSync(tmp, file);
  try { require('./provenance.js').wrote(file, txt, WRITER, { root }); } catch (_) {}
}
function writeShadowSummary(root, cfg) {
  const body = shadowSummary(tailRows(root, 'shadow', 8 * 1024 * 1024), label(cfg));
  const f = path.join(root, 'company', 'state', 'model-bench', slug(label(cfg)) + '.shadow.json');
  writeLocked(f, JSON.stringify(body, null, 1) + '\n', root);
  return f;
}

/* ---------------- study -> bench -> promote or roll back ---------------- */
function levelsOf(res) {
  const out = {};
  for (const [k, v] of Object.entries((res && res.kinds) || {})) for (const [d, L] of Object.entries(v.levels || {})) out[k + '|' + d] = L.passed == null ? null : Number(L.passed);
  return out;
}
/* promote only when the total passed count rises and no (kind, depth) level loses more than `tolerance` passes; a level
   the live version proved and the candidate could not be scored at counts as worse */
function promoteGate(live, cand, tolerance) {
  const tol = Math.max(0, Number(tolerance) || 0), lv = levelsOf(live), cv = levelsOf(cand);
  let lt = 0, ct = 0; const worse = [];
  for (const key of [...new Set(Object.keys(lv).concat(Object.keys(cv)))].sort()) {
    const l = lv[key], c = cv[key];
    if (l == null && c == null) continue;
    if (c == null) { worse.push(key.replace('|', ' ') + ' not proven'); lt += l; continue; }
    lt += l || 0; ct += c;
    if (l != null && c < l - tol) worse.push(key.replace('|', ' ') + ' ' + l + ' -> ' + c);
  }
  if (worse.length) return { promote: false, liveTotal: lt, candidateTotal: ct, reason: 'worse at ' + worse.join(', ') };
  if (!(ct > lt)) return { promote: false, liveTotal: lt, candidateTotal: ct, reason: 'no gain (' + lt + ' -> ' + ct + ')' };
  return { promote: true, liveTotal: lt, candidateTotal: ct, reason: 'gain ' + lt + ' -> ' + ct + ', no level worse' };
}
const brief = res => Object.fromEntries(Object.entries((res && res.kinds) || {}).map(([k, v]) => [k, Object.fromEntries(Object.entries(v.levels).map(([d, L]) => [d, L.passed == null ? null : L.passed + '/' + L.instances]))]));
async function benchOne(B, unit, root, cfg, driver, ids) {
  const s = cfg.study;
  const r = await B.run({ unitDir: unit.dir, root, model: label(cfg), driver, kinds: s.kinds || [1, 2, 5], only: ids, seed: s._seed, repeat: Number(s.repeat) || 2, config: { freeProviders: [String(cfg.provider || 'apprentice')] } });
  r.result.source = 'bench'; r.result.routable = false;
  return r;
}
async function studyPass(root, cfg, o) {
  o = o || {};
  const A = require('./lib/apprentice/adapter'), Cl = require('./lib/apprentice/client');
  const s = cfg.study, now = Number(o.now) || Date.now(), st = loadState(root);
  const unit = unitFor(root, o);
  const res = { studied: null, candidates: 0, decisions: [] };
  if (!unit.installed && !o.unit) { appendLog(root, 'decisions', { event: 'study', outcome: 'skipped', reason: 'the model-bench unit is not installed (unit.js install packs/model-bench --by owner)' }, cfg); res.skipped = 'bench-unit-not-installed'; return res; }
  const B = benchLib(unit.dir);
  const g = B.gate(label(cfg), unit.dir, root, { config: { freeProviders: [String(cfg.provider || 'apprentice')] } });
  if (!g.ok) { res.skipped = 'gate: ' + g.reason; appendLog(root, 'decisions', { event: 'study', outcome: 'skipped', reason: res.skipped }, cfg); return res; }
  const client = o.client || Cl.makeClient({ root, cfg, key: secretAt(root, cfg.keySecret) });
  const deadline = Date.now() + (Number(s.wallBudgetMin) || 120) * 60e3;
  st.lastStudyTryAt = now; saveState(root, st);
  let sr;
  try { sr = await client.study({ reason: 'scheduled' }); } catch (e) { res.error = String(e.message || e).slice(0, 200); appendLog(root, 'decisions', { event: 'study', outcome: 'error', reason: res.error }, cfg); return res; }
  st.lastStudyAt = now; saveState(root, st);
  res.studied = A.studyReply(sr.json);
  let units = [];
  try { const ur = await client.units(); units = A.unitsReply(ur.json); } catch (_) {}
  const seen = id => st.decided[id] || st.refused[id];
  let cands = units.filter(u => u.candidate && !u.live && !seen(u.id));
  const sid = res.studied.unitId;
  if (sid && !seen(sid) && !cands.some(u => u.id === sid) && !units.some(u => u.id === sid && u.live)) cands.push({ id: sid, status: res.studied.status });
  cands = cands.slice(0, Math.max(1, Number(s.maxCandidates) || 2));
  res.candidates = cands.length;
  if (!cands.length) appendLog(root, 'decisions', { event: 'study', outcome: 'no-candidate', status: sr.status }, cfg);
  const depths = s.depths || ['lookup', 'simple'];
  const ids = B.loadTasks(unit.dir, { kinds: s.kinds || [1, 2, 5] }).filter(t => depths.includes(t.depth) && t.sandbox === 'none' && !t.inputs.tools.length).map(t => t.id);
  for (const u of cands) {
    // a fresh seed per cycle (it cannot memorise instances), the same for the live version and the candidate (paired)
    s._seed = Number(o.seed) || crypto.randomInt(1, 2 ** 31 - 1);
    const dl = Cl.apprenticeDriver({ client, model: liveModel(cfg), label: label(cfg), deadline });
    const dc = Cl.apprenticeDriver({ client, model: A.candidateModel(cfg, u.id), unitId: u.id, label: label(cfg) + '@' + u.id, deadline });
    const live = await benchOne(B, unit, root, cfg, dl, ids);
    const cand = await benchOne(B, unit, root, cfg, dc, ids);
    const base = { event: 'decision', unit: u.id, seed: s._seed, repeat: Number(s.repeat) || 2, tolerance: Number(s.tolerance) || 0, live: brief(live.result), candidate: brief(cand.result) };
    if (dl.outOfTime || dc.outOfTime) { appendLog(root, 'decisions', Object.assign(base, { action: 'none', outcome: 'incomplete', reason: 'the study budget ran out before both benches finished; nothing decided' }), cfg); res.decisions.push({ unit: u.id, outcome: 'incomplete' }); break; }
    const gate = promoteGate(live.result, cand.result, s.tolerance);
    const action = gate.promote ? 'promote' : 'rollback';
    let r;
    try { r = await (gate.promote ? client.promote(u.id, { reason: gate.reason, evidence: { live: base.live, candidate: base.candidate, seed: s._seed } }) : client.rollback(u.id, { reason: gate.reason })); }
    catch (e) { r = { status: 0, text: String(e.message || e) }; }
    let outcome;
    if (gate.promote && A.refusedSelfApproval(r.status)) { outcome = 'refused-by-server'; st.refused[u.id] = now; }   // logged, never retried
    else if (r.status >= 200 && r.status < 300) outcome = gate.promote ? 'promoted' : 'rolled-back';
    else outcome = action + '-failed-' + r.status;
    st.decided[u.id] = { at: now, outcome };
    saveState(root, st);
    appendLog(root, 'decisions', Object.assign(base, { action, outcome, status: r.status, reason: gate.reason, liveTotal: gate.liveTotal, candidateTotal: gate.candidateTotal }), cfg);
    res.decisions.push({ unit: u.id, action, outcome, reason: gate.reason });
    // the live version's bench result: the candidate's after a promote, else the live run's
    const keep = outcome === 'promoted' ? cand : live;
    keep.result.model = label(cfg); keep.result.unit = outcome === 'promoted' ? u.id : null;
    try {
      require('./model-bench.js').writeResult(root, keep.result, { at: keep.result.ranAt, model: label(cfg), seed: s._seed, benchVersion: keep.result.benchVersion, complete: false, source: 'bench', routable: false,
        proven: Object.fromEntries(Object.entries(keep.result.kinds).map(([k, v]) => [k, v.proven])), instances: keep.records.length, passed: keep.records.filter(x => x.pass).length }, WRITER);
    } catch (e) { appendLog(root, 'log', { event: 'study', error: 'result not written: ' + String(e.message).slice(0, 160) }, cfg); }
  }
  delete s._seed;
  return res;
}

/* ---------------- the tick (started by the dispatcher, detached) ---------------- */
async function tick(o) {
  o = o || {};
  const root = rootOf(o), cfg = config(root, o), g = guards(root, cfg, o);
  if (!g.ok) return { code: 3, out: { ok: false, refused: true, why: g.why } };
  const now = Number(o.now) || Date.now(), st = loadState(root);
  const doShadow = o.forceShadow || shadowDue(cfg, st, now), doStudy = o.forceStudy || studyDue(cfg, st, now);
  if (!doShadow && !doStudy) return { code: 0, out: { ok: true, nothingDue: true } };
  const budget = (doStudy ? Number(cfg.study.wallBudgetMin) || 120 : 0) + (Number(cfg.wallBudgetMin) || 10);
  const release = takeLock(root, budget * 60e3);
  if (!release) return { code: 3, out: { ok: false, refused: true, why: ['another apprentice pass holds the lock'] } };
  const out = { ok: true };
  try {
    if (doShadow) out.shadow = await shadowPass(root, cfg, o);
    if (doStudy && config(root, o).enabled) out.study = await studyPass(root, cfg, o);
  } catch (e) { out.ok = false; out.error = String(e.message || e).slice(0, 300); try { appendLog(root, 'log', { event: 'tick', error: out.error }, cfg); } catch (_) {} }
  finally { release(); }
  return { code: out.ok ? 0 : 1, out };
}

/* ---------------- the owner's switch ---------------- */
function writeOwnerConfig(root, next) {
  const f = path.join(root, CONFIG_REL);
  const txt = JSON.stringify(Object.assign({ _doc: 'The owner\'s apprentice settings (apprentice.js enable|configure --by owner). A hand edit turns it off.' }, next, { at: new Date().toISOString() }), null, 1) + '\n';
  writeLocked(f, txt, root);
}
function ownerSwitch(root, a, o, what) {
  const O = require('./lib/owner');
  const current = ownerFile(root, o);
  const cur = Object.assign({}, current.trusted && current.conf ? current.conf : {}); delete cur._doc; delete cur.at;
  if (what === 'disable') {   // the kill switch: anyone may turn it off, and it is recorded
    if (!a.by || a.by === true) return { code: 2, out: { ok: false, error: 'say who: disable --by <name>' } };
    cur.enabled = false; cur.disabledBy = String(a.by).slice(0, 60);
    writeOwnerConfig(root, cur); return { code: 0, out: { ok: true, enabled: false } };
  }
  if (!O.isOwnerName(a.by)) return { code: 3, out: { ok: false, refused: true, why: 'only the owner turns the apprentice on or configures it (--by owner)' } };
  const no = O.refusal(a.by, 'the apprentice', o && typeof o.shell === 'function' ? { shell: o.shell } : {});
  if (no) return { code: 3, out: { ok: false, refused: true, why: no } };
  if (what === 'enable') { cur.enabled = true; delete cur.disabledBy; }
  if (what === 'configure') {
    const map = { 'base-url': 'baseUrl', namespace: 'namespace', tenant: 'tenant', 'key-secret': 'keySecret' };
    let n = 0;
    for (const [flag, key] of Object.entries(map)) if (a[flag] !== undefined && a[flag] !== true) {
      const v = String(a[flag]);
      if (key === 'baseUrl') { try { const u = new URL(v); if (!/^https?:$/.test(u.protocol)) throw new Error(); } catch (_) { return { code: 2, out: { ok: false, error: '--base-url must be an http(s) url' } }; } }
      else if (!/^[A-Za-z0-9._-]{1,80}$/.test(v)) return { code: 2, out: { ok: false, error: '--' + flag + ' may hold letters, digits, dot, dash and underscore' } };
      cur[key] = v; n++;
    }
    for (const [flag, key] of [['daily-cap', 'dailyCap'], ['per-tick-cap', 'perTickCap']]) if (a[flag] !== undefined) {
      const v = Number(a[flag]); if (!Number.isInteger(v) || v < 0 || v > 500) return { code: 2, out: { ok: false, error: '--' + flag + ' must be a whole number from 0 to 500' } };
      cur.shadow = Object.assign({}, cur.shadow || {}, { [key]: v }); n++;
    }
    if (!n) return { code: 2, out: { ok: false, error: 'say what to set: --base-url, --namespace, --tenant, --key-secret, --daily-cap, --per-tick-cap' } };
  }
  writeOwnerConfig(root, cur);
  return { code: 0, out: Object.assign({ ok: true }, cur) };
}

/* ---------------- status ---------------- */
function status(root, o) {
  const cfg = config(root, o), g = guards(root, cfg, o), st = loadState(root), now = Number(o && o.now) || Date.now();
  const sf = readJson(path.join(root, 'company', 'state', 'model-bench', slug(label(cfg)) + '.shadow.json'), null);
  return { enabled: cfg.enabled, runnable: g.ok, why: g.why, model: label(cfg), baseUrl: cfg.baseUrl || null, tenant: cfg.tenant, keyPresent: !!secretAt(root, cfg.keySecret),
    today: { date: localDate(now), shadowed: (st.days[localDate(now)] || {}).shadowed || 0, dailyCap: cfg.shadow.dailyCap },
    shadowed: Object.values(st.done).filter(d => d.outcome === 'scored').length, skippedForGood: Object.values(st.done).filter(d => d.outcome !== 'scored').length, waiting: Object.keys(st.waiting).length,
    lastShadowAt: st.lastShadowAt ? new Date(st.lastShadowAt).toISOString() : null, lastStudyAt: st.lastStudyAt ? new Date(st.lastStudyAt).toISOString() : null,
    shadowDue: shadowDue(cfg, st, now), studyDue: studyDue(cfg, st, now), locked: lockHeld(root),
    decisions: tailRows(root, 'decisions', 256 * 1024).slice(-5).map(r => ({ at: r.at, unit: r.unit || null, action: r.action || null, outcome: r.outcome, reason: r.reason || null })),
    shadowScores: sf ? sf.kinds : null };
}
function statusText(s) {
  const out = ['apprentice ' + s.model + ': ' + (s.enabled ? 'on' : 'off') + (s.runnable ? ', runnable' : ' (' + s.why.join('; ') + ')'),
    'today ' + s.today.date + ': ' + s.today.shadowed + '/' + s.today.dailyCap + ' shadow jobs; ' + s.shadowed + ' shadowed in all, ' + s.waiting + ' waiting for a transcript',
    'last shadow pass: ' + (s.lastShadowAt || 'never') + '; last study: ' + (s.lastStudyAt || 'never')];
  for (const [k, v] of Object.entries(s.shadowScores || {})) out.push('  kind ' + k + ': ' + Object.entries(v.levels).map(([d, L]) => d + ' ' + L.passed + '/' + L.n).join(', ') + ' (shadow)');
  for (const d of s.decisions) out.push('  ' + d.at + ' ' + (d.unit || '') + ' ' + (d.action || '') + ' ' + d.outcome + (d.reason ? ': ' + d.reason : ''));
  return out.join('\n');
}

/* ---------------- CLI ---------------- */
function args(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x.startsWith('--')) { const k = x.slice(2); const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) a[k] = true; else { a[k] = v; i++; } }
    else a._.push(x);
  }
  return a;
}
const USAGE = 'usage: apprentice.js status [--json] | config [--json] | shadow --once [--dry-run] | study --once [--seed N] | promote-gate --live <file> --candidate <file> [--tolerance N] | tick | enable --by owner | disable --by <name> | configure --by owner [--base-url U] [--namespace N] [--tenant T] [--key-secret S] [--daily-cap N] [--per-tick-cap N] | --selftest';
async function cmd(argv, o) {
  o = o || {};
  const root = rootOf(o), a = args(argv), sub = a._[0];
  if (sub === 'status') { const s = status(root, o); return a.json ? { code: 0, out: s } : { code: 0, text: statusText(s) }; }
  if (sub === 'config') { const c = config(root, o); return { code: 0, out: Object.assign({}, c, { keyPresent: !!secretAt(root, c.keySecret) }) }; }
  if (sub === 'enable' || sub === 'disable' || sub === 'configure') return ownerSwitch(root, a, o, sub);
  if (sub === 'promote-gate') {
    if (!a.live || !a.candidate || a.live === true || a.candidate === true) return { code: 2, out: { ok: false, error: 'promote-gate --live <file> --candidate <file>' } };
    const l = readJson(path.resolve(a.live), null), c = readJson(path.resolve(a.candidate), null);
    if (!l || !c) return { code: 2, out: { ok: false, error: 'both files must be model-bench results (json)' } };
    return { code: 0, out: promoteGate(l, c, a.tolerance === undefined ? config(root, o).study.tolerance : a.tolerance) };
  }
  if (sub === 'tick') return tick(Object.assign({}, o, { root }));
  if (sub === 'shadow' || sub === 'study') {
    if (!a.once) return { code: 2, out: { ok: false, error: sub + ' --once runs one pass now (the dispatcher runs them on their schedule)' } };
    const cfg = config(root, o);
    if (sub === 'shadow' && a['dry-run']) return { code: 0, out: Object.assign({ ok: true, guards: guards(root, cfg, o) }, await shadowPass(root, cfg, Object.assign({}, o, { dryRun: true }))) };
    const g = guards(root, cfg, o); if (!g.ok) return { code: 3, out: { ok: false, refused: true, why: g.why } };
    const release = takeLock(root, ((sub === 'study' ? Number(cfg.study.wallBudgetMin) || 120 : 0) + (Number(cfg.wallBudgetMin) || 10)) * 60e3);
    if (!release) return { code: 3, out: { ok: false, refused: true, why: ['another apprentice pass holds the lock'] } };
    try {
      const r = sub === 'shadow' ? await shadowPass(root, cfg, o) : await studyPass(root, cfg, Object.assign({}, o, { seed: a.seed && a.seed !== true ? Number(a.seed) : o.seed }));
      return { code: r.error ? 1 : 0, out: Object.assign({ ok: !r.error }, r) };
    } finally { release(); }
  }
  return { code: 2, out: { ok: false, error: USAGE } };
}

/* ---------------- selftest: a stub apprentice server, a fixture company, no network beyond 127.0.0.1 ---------------- */
async function selftest() {
  const http = require('http');
  const life = require('./lib/temp-life');
  let fails = 0;
  const t = (name, ok, extra) => { if (ok) console.log('  ok   ' + name); else { fails++; console.log('  FAIL ' + name + (extra ? ': ' + extra : '')); } };
  const FIX = path.join(__dirname, 'tests', 'fixtures', 'ranking');
  const NOW = readJson(path.join(FIX, 'now.json'), {}).now;
  const root = life.tmpDir('apprentice-selftest-');
  fs.cpSync(path.join(FIX, 'root'), root, { recursive: true });
  const SECRET = 'planted-' + crypto.randomBytes(12).toString('hex'), KEY = 'key-' + crypto.randomBytes(12).toString('hex'), MARK = 'APPRENTICE-WORDS-' + crypto.randomBytes(4).toString('hex');
  fs.mkdirSync(path.join(root, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'secrets', 'vendor-token'), SECRET + '\n');
  const FRAMEWORK_UNIT = { dir: path.join(__dirname, '..', '..', 'packs', 'model-bench'), installed: false };
  const B = benchLib(FRAMEWORK_UNIT.dir);

  // the bench's own oracle answers, by prompt, for the study cycles (seeds S and S + 7919 for repeat 2)
  const SEED = 4242, oracle = new Map();
  for (const task of B.loadTasks(FRAMEWORK_UNIT.dir, { kinds: [1, 2, 5] }).filter(x => ['lookup', 'simple'].includes(x.depth))) for (const sd of [SEED, SEED + 7919]) {
    const inst = B.instantiate(FRAMEWORK_UNIT.dir, task, sd); oracle.set(B.prompt(FRAMEWORK_UNIT.dir, task, inst), { task, answer: inst.oracle && inst.oracle.answer });
  }
  const right = { live: tk => tk.kind !== 5, 'u-gain': () => true, 'u-mixed': tk => !(tk.kind === 2 && tk.depth === 'simple'), 'u-self': () => true };
  const reqs = [], units = [];
  let nextStudy = 'u-gain';
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      let j = null; try { j = JSON.parse(body); } catch (_) {}
      reqs.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, body, json: j });
      const send = (code, x) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(x)); };
      if (req.headers.authorization !== 'Bearer ' + KEY) return send(401, { error: 'no key' });
      if (req.url === '/v1/chat/completions') {
        const p = j.messages[0].content, m = String(j.model).split('@')[1] || 'live';
        let text;
        if (j.metadata && j.metadata.purpose === 'shadow') {
          // the shadow task: q1 right, the rest a word the teacher never wrote
          const ids = [...p.matchAll(/^- (q\d+): /gm)].map(x => x[1]);
          text = 'From the files.\n```json\n' + JSON.stringify({ answers: ids.map((id, i) => ({ id, value: i === 0 ? 'Northwind Ltd' : MARK })) }) + '\n```';
        } else {
          const o = oracle.get(p);
          text = o && right[m] && right[m](o.task) ? 'Answer.\n```json\n' + JSON.stringify(o.answer) + '\n```' : 'I do not know. ' + MARK;
        }
        return send(200, { model: j.model, choices: [{ message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      }
      if (/\/trajectories$/.test(req.url)) return send(200, { accepted: 1 });
      if (/\/study$/.test(req.url)) { units.push({ unit_id: nextStudy, status: 'candidate' }); return send(200, { unit_id: nextStudy, status: 'candidate' }); }
      if (/\/units$/.test(req.url)) return send(200, { units });
      const pm = /\/units\/([^/]+)\/(promote|rollback)$/.exec(req.url);
      if (pm) { if (pm[2] === 'promote' && pm[1] === 'u-self') return send(403, { error: 'self-approval refused' }); const u = units.find(x => x.unit_id === pm[1]); if (u) u.status = pm[2] === 'promote' ? 'live' : 'rolled_back'; return send(200, { ok: true }); }
      return send(404, { error: 'no route' });
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const sb = { isSandbox: () => true };
  try {
    // 1. off by default: nothing is due, a tick refuses, the stub hears nothing
    t('off by default: not due', due({ root, now: NOW, ...sb }) === false);
    let r = await cmd(['tick'], { root, now: NOW, ...sb });
    t('off by default: a tick refuses and sends nothing', r.code === 3 && reqs.length === 0, JSON.stringify(r.out));
    // 2. only the owner turns it on, through the tool; a hand edit turns it off
    r = await cmd(['enable', '--by', 'some-seat'], { root });
    t('a seat cannot turn it on', r.code === 3 && !fs.existsSync(path.join(root, CONFIG_REL)));
    r = await cmd(['configure', '--by', 'owner', '--base-url', 'http://127.0.0.1:' + port, '--namespace', 'stubns', '--tenant', 'sandbox', '--key-secret', 'apprentice-key'], { root, shell: () => true });
    t('the owner configures it', r.code === 0, JSON.stringify(r.out));
    r = await cmd(['enable', '--by', 'owner'], { root, shell: () => true });
    t('the owner turns it on', r.code === 0 && config(root).enabled === true, JSON.stringify(config(root).why));
    t('without the key it is not due', due({ root, now: NOW, ...sb }) === false);
    fs.writeFileSync(path.join(root, 'secrets', 'apprentice-key'), KEY + '\n');
    t('outside the sandbox it is not due', due({ root, now: NOW, isSandbox: () => false }) === false && due({ root, now: NOW }) === false);
    t('on, sandbox, key: due', due({ root, now: NOW, ...sb }) === true);
    const cf = path.join(root, CONFIG_REL), good = fs.readFileSync(cf, 'utf8');
    fs.writeFileSync(cf, good.replace('"tenant": "sandbox"', '"tenant": "other"'));
    t('a hand edit of the owner config turns it off', config(root).enabled === false && due({ root, now: NOW, ...sb }) === false);
    fs.writeFileSync(cf, good);
    try { require('./provenance.js').wrote(cf, good, 'some-seat-script', { root }); } catch (_) {}
    t('a write recorded by another writer turns it off', config(root).enabled === false);
    await cmd(['enable', '--by', 'owner'], { root, shell: () => true });
    t('settings from an untrusted file are not carried over', config(root).enabled === true && !config(root).baseUrl);
    await cmd(['configure', '--by', 'owner', '--base-url', 'http://127.0.0.1:' + port, '--namespace', 'stubns', '--tenant', 'sandbox', '--key-secret', 'apprentice-key'], { root, shell: () => true });
    t('turned on again and configured by the owner', config(root).enabled === true && config(root).baseUrl === 'http://127.0.0.1:' + port);

    // 3. the shadow pass. Transcripts: S08 (passed first time) with a read that carries a planted secret; S03 (REVISE)
    // and S05 (reopened) also have transcripts, and must not be shadowed
    const M = require('./model-rank.js');
    const an = M.analyze(M.load({ root, now: NOW }));
    const byId = id => an.items.find(i => i.id === id);
    const S08 = byId('S08'), S03 = byId('S03'), S05 = byId('S05'), S10 = byId('S10');
    t('the item rows carry their run id', S08 && S08.runId && Array.isArray(S08.runs) && S08.runs.includes(S08.runId), S08 && JSON.stringify(Object.keys(S08)));
    const tdir = path.join(root, '.starnet-data', 'workspaces', 'transcript-history-v2'); fs.mkdirSync(tdir, { recursive: true });
    const rows = [];
    for (const it of [S08, S03, S05, S10]) {
      const run = an.runById.get(it.runId), at = Number(run.startedAt);
      rows.push({ role: 'assistant', sourceRunId: it.runId, streamId: 'cron-' + it.runId, ts: at + 1000, content: 'Reading the client notes.', toolCalls: JSON.stringify([{ id: 'c1-' + it.id, function: { name: 'fs_read', arguments: JSON.stringify({ path: 'clients/northwind.md' }) } }, { id: 'c2-' + it.id, function: { name: 'shell_exec', arguments: JSON.stringify({ command: 'rm -rf /tmp/x' }) } }]) });
      rows.push({ role: 'tool', toolCallId: 'c1-' + it.id, sourceRunId: it.runId, ts: at + 2000, content: 'Client: Northwind Ltd\nRate: 85 EUR per hour\napi token ' + SECRET + '\n', taint: 'none' });
      rows.push({ role: 'tool', toolCallId: 'c2-' + it.id, sourceRunId: it.runId, ts: at + 2500, content: 'removed', taint: 'none' });
      rows.push({ role: 'assistant', sourceRunId: it.runId, ts: at + 3000, content: 'Done.\n\n**Client:** Northwind Ltd\n**Contract owner:** Dana Ruiz' });
    }
    fs.writeFileSync(path.join(tdir, 'segment-000001.jsonl'), rows.map(x => JSON.stringify(x)).join('\n') + '\n');
    fs.writeFileSync(path.join(tdir, 'segment-000001.index.json'), JSON.stringify({ version: 1, segment: 1, rows: rows.length, minTs: NOW - 40 * 864e5, maxTs: NOW - 3600e3, streams: {} }));
    const override = Object.assign({}, readJson(cf, {}), { shadow: { kinds: { code: 1, mechanical: 1 }, classDepth: { code: 'lookup', mechanical: 'lookup' }, dailyCap: 1, perTickCap: 5 } });
    const O = { root, now: NOW, unit: FRAMEWORK_UNIT, configOverride: override, ...sb };
    r = await cmd(['shadow', '--once', '--dry-run'], O);
    t('a dry run plans the shadow job and sends nothing', r.code === 0 && r.out.planned.length === 1 && r.out.planned[0].item.endsWith('\nS08') && reqs.length === 0, JSON.stringify(r.out).slice(0, 400));
    r = await cmd(['shadow', '--once'], O);
    const chats = reqs.filter(x => x.url === '/v1/chat/completions'), lessons = reqs.filter(x => /\/trajectories$/.test(x.url));
    t('one validated item is shadowed (the daily cap of 1 holds)', r.code === 0 && r.out.shadowed === 1 && chats.length === 1 && (r.out.skipped.cap || 0) >= 1, JSON.stringify(r.out));
    t('the job went as one user message with no tools', chats.length === 1 && chats[0].json.messages.length === 1 && chats[0].json.messages[0].role === 'user' && !['tools', 'tool_choice', 'functions'].some(k => k in chats[0].json));
    t('the prompt carries the job and what the run read, not the answer', chats[0] && /clients\/northwind\.md/.test(chats[0].body) && /q1: Client/.test(chats[0].body) && !/Dana Ruiz/.test(JSON.parse(chats[0].body).messages[0].content));
    t('a planted secret never reaches the stub (scrubbed)', reqs.every(x => !x.body.includes(SECRET)) && chats[0] && chats[0].body.includes('[REDACTED:'));
    t('a write shell command is not part of the snapshot', chats[0] && !/rm -rf/.test(chats[0].body));
    t('the key goes only in the Authorization header', reqs.every(x => x.auth === 'Bearer ' + KEY) && reqs.every(x => !x.body.includes(KEY)));
    const les = lessons[0] && lessons[0].json && lessons[0].json.trajectories[0];
    t('the lesson is posted with the teacher, the student and the score', les && les.teacher.answer.includes('Dana Ruiz') && les.student.answer.includes(MARK) && les.benchKind === 1 && les.depth === 'lookup' && les.score === 0.5 && les.pass === false, les && JSON.stringify({ k: les.benchKind, s: les.score }));
    const shRows = tailRows(root, 'shadow');
    t('REVISE and reopened items are never shadowed', !shRows.some(x => x.item === S03.key || x.item === S05.key) && !chats.some(c => /S03|S05/.test(c.body)));
    const shf = readJson(path.join(root, 'company', 'state', 'model-bench', 'apprentice_stubns_sandbox.shadow.json'), null);
    t('the shadow scores are written per kind and depth, marked shadow', shf && shf.schema === 'model-bench-shadow/1' && shf.source === 'shadow' && shf.kinds['1'].levels.lookup.n === 1 && shf.live[0].oneShot === 0, JSON.stringify(shf));
    r = await cmd(['shadow', '--once'], O);
    t('the daily cap holds on the next pass the same day', r.code === 0 && r.out.shadowed === 0 && reqs.filter(x => x.url === '/v1/chat/completions').length === 1);
    r = await cmd(['shadow', '--once'], Object.assign({}, O, { now: NOW + 864e5 }));
    t('the next day the other item is shadowed, the first is never sent twice', r.out.shadowed === 1 && reqs.filter(x => x.url === '/v1/chat/completions').length === 2 && tailRows(root, 'shadow').filter(x => x.item === S08.key && x.outcome === 'scored').length === 1, JSON.stringify(r.out));

    // 4. study -> bench -> promote on a gain, roll back on a level that got worse, a server refusal is never retried
    const before = reqs.length;
    r = await cmd(['study', '--once', '--seed', String(SEED)], O);
    const d1 = r.out.decisions && r.out.decisions[0];
    t('a candidate that gains everywhere is promoted', r.code === 0 && d1 && d1.unit === 'u-gain' && d1.outcome === 'promoted', JSON.stringify(r.out));
    t('the bench ran through the direct client, no tools', reqs.slice(before).filter(x => x.url === '/v1/chat/completions').length > 0 && reqs.slice(before).every(x => !x.json || !('tools' in x.json)) && reqs.slice(before).filter(x => x.json && x.json.metadata && x.json.metadata.purpose === 'bench').every(x => x.json.metadata.learn === false));
    const res = readJson(path.join(root, 'company', 'state', 'model-bench', 'apprentice_stubns_sandbox.json'), null);
    t('the live result is a model-bench/1 file, not routable', res && res.schema === 'model-bench/1' && res.routable === false && res.source === 'bench' && res.unit === 'u-gain', res && JSON.stringify({ s: res.schema, r: res.routable }));
    const inDir = fs.readdirSync(path.join(root, 'company', 'state', 'model-bench')).filter(f => f.endsWith('.json') && !f.endsWith('.prev.json')).map(f => readJson(path.join(root, 'company', 'state', 'model-bench', f), {})).filter(x => x.schema === 'model-bench/1');
    t('a reader of model-bench/1 files skips the shadow file', inDir.length === 1 && inDir[0].source === 'bench');
    nextStudy = 'u-mixed';
    r = await cmd(['study', '--once', '--seed', String(SEED)], O);
    const d2 = r.out.decisions && r.out.decisions[0];
    t('a candidate with a higher total but one level worse is rolled back', d2 && d2.unit === 'u-mixed' && d2.outcome === 'rolled-back' && /worse at 2 simple/.test(d2.reason), JSON.stringify(r.out));
    nextStudy = 'u-self';
    r = await cmd(['study', '--once', '--seed', String(SEED)], O);
    const d3 = r.out.decisions && r.out.decisions[0];
    t('the server\'s 403 on a promote is logged as refused-by-server', d3 && d3.outcome === 'refused-by-server', JSON.stringify(r.out));
    r = await cmd(['study', '--once', '--seed', String(SEED)], O);
    t('a refused or decided unit is never retried', reqs.filter(x => /u-self\/promote$/.test(x.url)).length === 1 && reqs.filter(x => /u-gain\/promote$/.test(x.url)).length === 1 && (r.out.decisions || []).length === 0, JSON.stringify(r.out));
    const dec = tailRows(root, 'decisions');
    t('every decision is logged with both results and the reason', dec.filter(x => x.event === 'decision').length === 3 && dec.every(x => x.event !== 'decision' || (x.live && x.candidate && x.reason)));

    // 5. the apprentice's words are nowhere in the company (only its scores)
    const hits = [];
    (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (fs.readFileSync(f, 'utf8').includes(MARK)) hits.push(path.relative(root, f)); } })(root);
    t('the apprentice\'s text never lands in a company file', hits.length === 0, hits.join(', '));

    // 6. the kill switch: anyone may turn it off; then nothing runs
    r = await cmd(['disable', '--by', 'some-seat'], { root });
    const n0 = reqs.length;
    r = await cmd(['shadow', '--once'], Object.assign({}, O, { configOverride: undefined, now: NOW + 3 * 864e5 }));
    t('after disable nothing runs and nothing is sent', r.code === 3 && reqs.length === n0 && due({ root, now: NOW + 3 * 864e5, ...sb }) === false, JSON.stringify(r.out));
    // 7. the lock: a held lock refuses a second pass
    const rel = takeLock(root, 60e3);
    r = await cmd(['study', '--once'], O);
    t('a held lock refuses a second pass', r.code === 3 && /lock/.test(JSON.stringify(r.out)));
    rel();
    t('status reads', /apprentice /.test((await cmd(['status'], { root })).text));
  } finally { server.close(); life.cleanup(); }
  console.log(fails ? 'apprentice selftest: ' + fails + ' failed' : 'apprentice selftest: all passed');
  return fails ? 1 : 0;
}

module.exports = { cmd, due, config, guards, tick, shadowPass, studyPass, promoteGate, shadowSummary, shadowDue, studyDue, loadState, secretAt };
if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) selftest().then(c => process.exit(c), e => { console.error(e); process.exit(1); });
  else cmd(argv).then(r => {
    if (r.text !== undefined && !argv.includes('--json')) console.log(r.text);
    else console.log(JSON.stringify(r.out, null, 1));
    process.exit(r.code);
  }, e => { console.error('apprentice: ' + (e && e.message || e)); process.exit(2); });
}
