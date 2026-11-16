'use strict';
/* decision.js (lib) — decision models: a deterministic function from observed state to a recommended action. No LLM, no code.
 *
 * A model is pure data in company/decision-models/<id>/<version>.json (tracked defaults; a pack may ship more under
 * company/state/packs/installed/<pack>/decision-models/<id>/<version>.json). It names its inputs (field, type,
 * sensitive?), optional owner-set params (closed defaults), an optional scoring list, a rule list evaluated in order
 * (first match wins) and a default. See docs/DECISION-MODELS.md.
 *
 *   const dm = require('./lib/decision');
 *   dm.evaluate('gate-triage', { category: 'spend', amountUsd: 3, ... }, { version?, log?, params?, root? })
 *     -> { action, rule, reason, score?, mode, model: { id, version, sha } }   (action null + error when the model is unusable)
 *   dm.list(opts)  dm.load(id, version, opts)  dm.validate(model)  dm.replay(id, version, { from })  dm.test(id, { version })
 *   dm.promote(id, version, { by, mode })  dm.setParam(id, name, value, { by })  dm.register(opts)
 *
 * Effective mode: a version runs "live" only when the owner promoted it (company/state/decision-models.json), the file
 * still has the sha it had when promoted, and the promotion or the model says live. Anything else runs in shadow: callers must not act on a shadow answer.
 * Every evaluation (unless log:false) is one row in company/work/decisions/<id>.jsonl: input digest, the input (fields
 * marked sensitive are left out and listed under `redacted`), the params used, the output. Replay re-runs those rows.
 * Unusable model (missing, malformed, unknown op) => action null; callers fail closed.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const co = require('./company');

const OPS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'regex', 'exists'];
const TYPES = ['string', 'number', 'boolean', 'array'];
const MODES = ['shadow', 'live'];
const ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
const VER_RE = /^[0-9]+(\.[0-9]+){0,2}$/;

const rootOf = opts => path.resolve((opts && opts.root) || process.env.DECISION_ROOT || co.ROOT);
const FRAMEWORK_MODELS = co.p('company', 'decision-models');
function files(opts) {
  const r = rootOf(opts);
  return { root: r, models: path.join(r, 'company', 'decision-models'), packs: path.join(r, 'company', 'state', 'packs', 'installed'),
    state: path.join(r, 'company', 'state', 'decision-models.json'), stateLog: path.join(r, 'company', 'state', 'decision-models-log.jsonl'),
    logDir: path.join(r, 'company', 'work', 'decisions'), lockedExtra: path.join(r, 'company', 'state', 'locked-extra.json'),
    decisions: path.join(r, 'company', 'work', 'decisions.md') };
}
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } };
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const canon = v => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v);
const cmpVer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };
function prov(kind, file, text) { try { require('../provenance.js')[kind](file, text, 'decide.js'); } catch (_) {} }
function writeAtomic(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); const t = file + '.tmp-' + process.pid; fs.writeFileSync(t, text); fs.renameSync(t, file); prov('wrote', file, text); }
function append(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, text); prov('appended', file, text); }

/* ---------- registry ---------- */
// model folders, in priority order: the company's own, the framework's (selftests on a scratch root), installed packs
function modelDirs(opts) {
  const f = files(opts); const out = [f.models];
  if (path.resolve(FRAMEWORK_MODELS) !== path.resolve(f.models)) out.push(FRAMEWORK_MODELS);
  try { for (const p of fs.readdirSync(f.packs).sort()) out.push(path.join(f.packs, p, 'decision-models')); } catch (_) {}
  return out;
}
function dirOf(id, opts) {
  if (!ID_RE.test(String(id || ''))) return null;
  for (const d of modelDirs(opts)) if (fs.existsSync(path.join(d, id))) return path.join(d, id);
  return null;
}
function versions(id, opts) {
  const d = dirOf(id, opts); if (!d) return [];
  return fs.readdirSync(d).filter(f => f.endsWith('.json') && VER_RE.test(f.slice(0, -5))).map(f => f.slice(0, -5)).sort(cmpVer);
}
function ids(opts) {
  const s = new Set();
  for (const d of modelDirs(opts)) { try { for (const x of fs.readdirSync(d)) if (ID_RE.test(x) && fs.statSync(path.join(d, x)).isDirectory()) s.add(x); } catch (_) {} }
  return [...s].sort();
}
function state(opts) { const s = readJson(files(opts).state, null) || {}; s.models = s.models || {}; s.params = s.params || {}; return s; }
function activeVersion(id, opts) {
  const vs = versions(id, opts); const pr = state(opts).models[id];
  if (pr && vs.includes(String(pr.version))) return String(pr.version);
  return vs.length ? vs[vs.length - 1] : null;
}
function load(id, version, opts) {
  const d = dirOf(id, opts); if (!d) return { error: 'no decision model ' + id };
  const v = version != null ? String(version) : activeVersion(id, opts);
  if (!v) return { error: 'decision model ' + id + ' has no versions' };
  const file = path.join(d, v + '.json');
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return { error: 'no version ' + v + ' of ' + id }; }
  let model; try { model = JSON.parse(text); } catch (e) { return { error: id + '/' + v + '.json is not JSON: ' + e.message }; }
  const errors = validate(model, { id, version: v });
  return { model, file, version: v, sha: sha(text).slice(0, 12), errors, error: errors.length ? id + '/' + v + ' is invalid: ' + errors.join('; ') : null };
}
function cases(id, opts) { const d = dirOf(id, opts); return d ? (readJson(path.join(d, 'cases.json'), null) || null) : null; }

/* ---------- validation (pure data, closed vocabulary) ---------- */
function validatePred(p, m, at, out, depth) {
  if (depth > 12) return out.push(at + ': nested too deep');
  if (!p || typeof p !== 'object' || Array.isArray(p)) return out.push(at + ': a predicate is an object');
  const keys = Object.keys(p);
  if (keys.includes('all') || keys.includes('any')) {
    const k = keys.includes('all') ? 'all' : 'any';
    if (keys.length !== 1 || !Array.isArray(p[k]) || !p[k].length) return out.push(at + ': ' + k + ' takes a non-empty list and nothing else');
    p[k].forEach((q, i) => validatePred(q, m, at + '.' + k + '[' + i + ']', out, depth + 1)); return;
  }
  if (keys.includes('not')) { if (keys.length !== 1) return out.push(at + ': not takes one predicate'); return validatePred(p.not, m, at + '.not', out, depth + 1); }
  for (const k of keys) if (!['field', 'op', 'value', 'param'].includes(k)) out.push(at + ': unknown key ' + k);
  if (p.field !== '$score' && !(m.inputs || {})[p.field]) out.push(at + ': field ' + p.field + ' is not a declared input');
  if (!OPS.includes(p.op)) return out.push(at + ': op ' + p.op + ' is not one of ' + OPS.join('/'));
  if ('param' in p) { if (!(m.params || {})[p.param]) out.push(at + ': param ' + p.param + ' is not declared'); if ('value' in p) out.push(at + ': value and param both given'); }
  else if (p.op !== 'exists' && !('value' in p)) out.push(at + ': ' + p.op + ' needs a value or a param');
  if (p.op === 'in' && !('param' in p) && !Array.isArray(p.value)) out.push(at + ': in takes a list');
  if (p.op === 'regex') { if (typeof p.value !== 'string' || p.value.length > 200) out.push(at + ': regex takes a string up to 200 chars'); else { try { new RegExp(p.value); } catch (e) { out.push(at + ': bad regex'); } } }
  if (p.op === 'exists' && 'value' in p && typeof p.value !== 'boolean') out.push(at + ': exists takes true/false');
}
function validate(m, want) {
  const out = [];
  if (!m || typeof m !== 'object') return ['not an object'];
  if (!ID_RE.test(String(m.id || ''))) out.push('id missing or malformed');
  if (want && want.id && m.id !== want.id) out.push('id ' + m.id + ' does not match its folder ' + want.id);
  if (want && want.version && String(m.version) !== want.version) out.push('version ' + m.version + ' does not match its file ' + want.version + '.json');
  if (!MODES.includes(m.mode)) out.push('mode must be shadow or live');
  if (!m.inputs || typeof m.inputs !== 'object') out.push('inputs missing');
  for (const [k, s] of Object.entries(m.inputs || {})) {
    if (k.startsWith('$')) out.push('input ' + k + ': names starting with $ are reserved');
    if (!s || !TYPES.includes(s.type)) out.push('input ' + k + ': type must be one of ' + TYPES.join('/'));
  }
  for (const [k, s] of Object.entries(m.params || {})) if (!s || !['number', 'string', 'boolean'].includes(s.type) || typeof s.default !== s.type) out.push('param ' + k + ': needs a type and a default of that type');
  if (!Array.isArray(m.actions) || !m.actions.length) out.push('actions: the list of possible actions is missing');
  const act = a => (m.actions || []).includes(a);
  (m.scoring || []).forEach((s, i) => { if (typeof s.weight !== 'number') out.push('scoring[' + i + ']: weight must be a number'); validatePred(s.when, m, 'scoring[' + i + '].when', out, 0); });
  if (!Array.isArray(m.rules)) out.push('rules must be a list');
  const seen = new Set();
  (m.rules || []).forEach((r, i) => {
    if (!r || !r.id || seen.has(r.id)) out.push('rules[' + i + ']: needs a unique id'); else seen.add(r.id);
    if (!act(r.action)) out.push('rules[' + i + ']: action ' + r.action + ' is not in actions');
    validatePred(r.when, m, 'rules[' + i + '].when', out, 0);
  });
  if (!m.default || !act(m.default.action)) out.push('default.action must be one of actions');
  return out;
}

/* ---------- evaluation ---------- */
function typeOk(t, v) { return t === 'array' ? Array.isArray(v) : typeof v === t && (t !== 'number' || Number.isFinite(v)); }
function sanitize(m, input) {
  const values = {}, ignored = [], invalid = [], missing = [];
  input = input && typeof input === 'object' ? input : {};
  for (const k of Object.keys(input)) if (!(m.inputs || {})[k]) ignored.push(k);
  for (const [k, s] of Object.entries(m.inputs || {})) {
    if (input[k] === undefined || input[k] === null) { if (s.required) missing.push(k); continue; }
    if (!typeOk(s.type, input[k])) { invalid.push(k); if (s.required) missing.push(k); continue; }
    values[k] = input[k];
  }
  return { values, ignored, invalid, missing };
}
function test(p, vals, params) {
  if (p.all) return p.all.every(q => test(q, vals, params));
  if (p.any) return p.any.some(q => test(q, vals, params));
  if (p.not) return !test(p.not, vals, params);
  const has = Object.prototype.hasOwnProperty.call(vals, p.field);
  if (p.op === 'exists') return has === (p.value !== false);
  if (!has) return false;                                     // every comparison on a missing field is false
  const v = vals[p.field]; const w = 'param' in p ? params[p.param] : p.value;
  switch (p.op) {
    case 'eq': return canon(v) === canon(w);
    case 'ne': return canon(v) !== canon(w);
    case 'lt': return typeof v === 'number' && typeof w === 'number' && v < w;
    case 'lte': return typeof v === 'number' && typeof w === 'number' && v <= w;
    case 'gt': return typeof v === 'number' && typeof w === 'number' && v > w;
    case 'gte': return typeof v === 'number' && typeof w === 'number' && v >= w;
    case 'in': return Array.isArray(w) && w.some(x => canon(x) === canon(v));
    case 'regex': return new RegExp(w).test(String(v).slice(0, 2000));
  }
  return false;
}
function paramsFor(m, opts) {
  const p = {}; for (const [k, s] of Object.entries(m.params || {})) p[k] = s.default;
  const set = state(opts).params[m.id] || {};
  for (const k of Object.keys(p)) if (typeof set[k] === typeof p[k]) p[k] = set[k];
  for (const [k, v] of Object.entries((opts && opts.params) || {})) if (k in p && typeof v === typeof p[k]) p[k] = v;
  return p;
}
function modeFor(id, version, m, opts, fileSha) {
  if (opts && MODES.includes(opts.mode)) return opts.mode;
  const pr = state(opts).models[id];
  if (!pr || String(pr.version) !== String(version)) return 'shadow';
  if (pr.sha && fileSha && pr.sha !== fileSha) return 'shadow';   // the file changed after the owner promoted it
  return MODES.includes(pr.mode) ? pr.mode : m.mode;
}
/* The pure part: model + input + params -> output (no files). */
function run(m, input, params) {
  const s = sanitize(m, input);
  const vals = Object.assign({}, s.values);
  let score;
  if ((m.scoring || []).length) { score = 0; for (const x of m.scoring) if (test(x.when, vals, params)) score += x.weight; vals.$score = score; }
  let rule = null, action, why;
  if (s.missing.length) { action = m.default.action; rule = '(input-invalid)'; why = 'required input missing or of the wrong type: ' + s.missing.join(', '); }
  else {
    const r = (m.rules || []).find(x => test(x.when, vals, params));
    if (r) { action = r.action; rule = r.id; why = r.why || r.id; } else { action = m.default.action; rule = '(default)'; why = m.default.why || 'no rule matched'; }
  }
  const out = { action, rule, reason: rule + ': ' + why };
  if (score !== undefined) out.score = score;
  if (s.ignored.length) out.ignored = s.ignored;
  if (s.invalid.length) out.invalid = s.invalid;
  return { out, values: s.values };
}
function evaluate(id, input, opts) {
  opts = opts || {};
  const L = load(id, opts.version, opts);
  if (!L.model || L.error) return { action: null, error: L.error, mode: 'shadow', model: { id, version: L.version || null, sha: L.sha || null } };
  const params = paramsFor(L.model, opts);
  const { out, values } = run(L.model, input, params);
  const mode = modeFor(id, L.version, L.model, opts, L.sha);
  const res = Object.assign(out, { mode, model: { id, version: L.version, sha: L.sha } });
  if (opts.log !== false) {
    const redacted = Object.keys(values).filter(k => L.model.inputs[k].sensitive);
    const kept = {}; for (const k of Object.keys(values)) if (!redacted.includes(k)) kept[k] = values[k];
    const row = { at: new Date().toISOString(), id, version: L.version, sha: L.sha, mode, inputDigest: sha(canon(values)).slice(0, 16), input: kept,
      redacted: redacted.length ? redacted : undefined, params, output: { action: res.action, rule: res.rule, score: res.score }, caller: opts.caller || undefined };
    try { append(path.join(files(opts).logDir, id + '.jsonl'), JSON.stringify(row) + '\n'); } catch (_) {}
  }
  return res;
}

/* ---------- log, replay, test ---------- */
function logRows(id, opts) {
  let txt = ''; try { txt = fs.readFileSync(path.join(files(opts).logDir, id + '.jsonl'), 'utf8'); } catch (_) { return []; }
  const out = []; for (const l of txt.split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch (_) {} }
  return out;
}
function replay(id, version, opts) {
  opts = opts || {};
  const L = load(id, version, opts); if (L.error) return { ok: false, error: L.error };
  const from = opts.from ? Date.parse(opts.from) : null;
  const rows = logRows(id, opts).filter(r => r.id === id && (!from || Date.parse(r.at) >= from));
  const dis = []; let agree = 0, partial = 0;
  for (const r of rows) {
    const { out } = run(L.model, r.input || {}, Object.assign(paramsFor(L.model, opts), r.params || {}));
    if (r.redacted && r.redacted.length) partial++;
    if (out.action === (r.output || {}).action) agree++;
    else dis.push({ at: r.at, inputDigest: r.inputDigest, was: { version: r.version, action: (r.output || {}).action, rule: (r.output || {}).rule }, now: { action: out.action, rule: out.rule }, partialInput: !!(r.redacted && r.redacted.length) });
  }
  return { ok: true, id, version: L.version, sha: L.sha, rows: rows.length, agree, disagree: dis.length, partialInputs: partial, disagreements: dis };
}
function runCases(id, opts) {
  opts = opts || {};
  const c = cases(id, opts); if (!c || !Array.isArray(c.cases)) return { ok: false, error: 'no cases.json for ' + id };
  const L = load(id, opts.version, opts); if (L.error) return { ok: false, error: L.error };
  const results = c.cases.map((k, i) => {
    const defaults = {}; for (const [n, s] of Object.entries(L.model.params || {})) defaults[n] = s.default;
    const { out } = run(L.model, k.input, Object.assign(defaults, k.params || {}));   // cases see the closed defaults, not the owner's settings
    return { name: k.name || 'case ' + (i + 1), expect: k.expect, got: out.action, rule: out.rule, pass: out.action === k.expect };
  });
  const miss = results.filter(r => !r.pass);
  return { ok: !miss.length, id, version: L.version, sha: L.sha, cases: results.length, misses: miss.length, results };
}

/* ---------- owner acts: promote, params; locked-watch registration ---------- */
const isOwnerName = by => { const b = String(by || '').trim().toLowerCase(); return !!b && (b === 'owner' || b === String((co.config.owner && co.config.owner.name) || '').trim().toLowerCase()); };
function underStation() { if (process.env.DECIDE_ASSUME_AGENT === '1') return true; try { return require('../provenance.js').underStation(); } catch (_) { return false; } }
function ownerRefusal(by) {
  if (!isOwnerName(by)) return 'only the owner promotes decision models or sets their params: --by must be "' + ((co.config.owner && co.config.owner.name) || 'Owner') + '" or "owner"';
  if (underStation()) return 'this runs inside an agent\'s station run: only the owner, from their own shell, does this';
  return null;
}
function recordOwner(opts, by, what, s) {
  const f = files(opts); const at = new Date().toISOString();
  s._doc = 'Which version of each decision model is live, and the owner-set params. Written only by company/tools/decide.js promote|set-param --by <owner>; watched by locked-watch.js (company/state/locked-extra.json).';
  writeAtomic(f.state, JSON.stringify(s, null, 2) + '\n');
  append(f.stateLog, JSON.stringify(Object.assign({ at, by }, what)) + '\n');
  if (!fs.existsSync(f.decisions)) append(f.decisions, '# Decisions\n\n');
  const lp = co.localParts(new Date(at));
  append(f.decisions, '- ' + lp.date + ' ' + lp.time + ' ' + by + ' (owner) ' + what.text + ' (company/tools/decide.js)\n');
  register(opts);
}
function promote(id, version, o, opts) {
  o = o || {};
  const why = ownerRefusal(o.by); if (why) return { ok: false, code: 3, error: why };
  if (o.mode != null && !MODES.includes(o.mode)) return { ok: false, code: 2, error: '--mode must be shadow or live' };
  const L = load(id, version, opts); if (L.error) return { ok: false, code: 2, error: L.error };
  const t = runCases(id, Object.assign({}, opts, { version: L.version }));
  if (t.error === undefined && !t.ok) return { ok: false, code: 1, error: 'cases.json has ' + t.misses + ' miss(es) against ' + id + ' v' + L.version + '; not promoted', test: t };
  const s = state(opts); const prev = s.models[id] || null;
  const mode = o.mode || L.model.mode;
  s.models[id] = { version: L.version, sha: L.sha, mode, by: o.by, at: new Date().toISOString() };
  recordOwner(opts, o.by, { op: 'promote', id, version: L.version, sha: L.sha, mode, from: prev && prev.version, text: 'promoted decision model ' + id + ' to v' + L.version + ' (' + mode + ')' }, s);
  return { ok: true, id, version: L.version, sha: L.sha, mode, from: prev ? prev.version + ' (' + prev.mode + ')' : null };
}
function setParam(id, name, value, o, opts) {
  o = o || {};
  const why = ownerRefusal(o.by); if (why) return { ok: false, code: 3, error: why };
  const L = load(id, null, opts); if (L.error) return { ok: false, code: 2, error: L.error };
  const spec = (L.model.params || {})[name]; if (!spec) return { ok: false, code: 2, error: id + ' has no param ' + name + '; one of ' + Object.keys(L.model.params || {}).join(', ') };
  let v = value;
  if (spec.type === 'number') { v = Number(value); if (!Number.isFinite(v)) return { ok: false, code: 2, error: name + ' is a number' }; }
  if (spec.type === 'boolean') { if (!['true', 'false', true, false].includes(value)) return { ok: false, code: 2, error: name + ' is true or false' }; v = value === true || value === 'true'; }
  const s = state(opts); s.params[id] = s.params[id] || {}; const from = name in s.params[id] ? s.params[id][name] : spec.default;
  s.params[id][name] = v;
  recordOwner(opts, o.by, { op: 'set-param', id, name, from, to: v, text: 'set decision model ' + id + ' param ' + name + ' ' + from + ' -> ' + v }, s);
  return { ok: true, id, name, from, to: v };
}
const LOCKED = [
  { p: 'company/decision-models/**', cls: 'F', owner: 'risk', area: 'policy', why: 'decision models (pure-data rules the company acts on); a change goes through review and replay' },
  { p: 'company/state/decision-models.json', cls: 'A', writers: ['decide.js'], owner: 'risk', area: 'policy', why: 'which decision-model version is live, and the owner-set thresholds' },
  { p: 'company/state/decision-models-log.jsonl', cls: 'A', append: true, writers: ['decide.js'], owner: 'risk', area: 'record', why: 'owner promotions and param changes' },
  { p: 'company/work/decisions/*.jsonl', cls: 'F', append: true, owner: 'risk', area: 'record', why: 'every decision-model evaluation (replay input)' },
];
function register(opts) {
  const f = files(opts); const cur = readJson(f.lockedExtra, null) || {};
  const rows = LOCKED.map(e => Object.assign({}, e, { source: 'decide.js' }));
  const kept = (cur.entries || []).filter(e => e.source !== 'decide.js');
  const next = Object.assign({}, cur, { entries: kept.concat(rows) });
  if (!next._doc) next._doc = 'Extra locked-watch entries (MANIFEST shape: p, cls, owner, area, why, writers?, append?) registered by company/tools/pack.js (pack:<id>), company/tools/module.js (module:<id>) and company/tools/decide.js (source decide.js). locked-watch.js appends them to its MANIFEST and watches this file itself.';
  const text = JSON.stringify(next, null, 2) + '\n';
  let before = null; try { before = fs.readFileSync(f.lockedExtra, 'utf8'); } catch (_) {}
  if (before === text) return { ok: true, unchanged: true, entries: rows.length };
  writeAtomic(f.lockedExtra, text);
  return { ok: true, entries: rows.length, file: path.relative(f.root, f.lockedExtra) };
}

function list(opts) {
  const s = state(opts);
  return ids(opts).map(id => {
    const vs = versions(id, opts); const av = activeVersion(id, opts); const L = load(id, av, opts);
    const rows = logRows(id, opts); const last = rows[rows.length - 1];
    const c = cases(id, opts);
    return { id, title: (L.model && L.model.title) || id, versions: vs, active: av, mode: L.model ? modeFor(id, av, L.model, opts, L.sha) : 'shadow',
      declaredMode: L.model && L.model.mode, valid: !L.error, error: L.error || undefined, sha: L.sha, promoted: s.models[id] || null,
      params: L.model ? paramsFor(L.model, opts) : {}, cases: c && Array.isArray(c.cases) ? c.cases.length : 0, evaluations: rows.length, lastAt: last ? last.at : null,
      source: path.relative(rootOf(opts), dirOf(id, opts) || '') || dirOf(id, opts) };
  });
}

module.exports = { OPS, MODES, files, ids, versions, activeVersion, load, validate, evaluate, run, replay, test: runCases, cases, promote, setParam, register, list, logRows, state, LOCKED, canon };
