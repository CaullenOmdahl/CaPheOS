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
 *
 * Fact provenance: an input may be marked `safety: true` with the `sources` allowed to vouch for it ('ledger',
 * 'external-gate-allowlist', 'competence', 'registry:parties', 'owner-table', 'tool:<name>', 'owner'; a trailing * is a
 * prefix). evaluate() takes each fact plain or as { value, source, ref? }. A safety fact counts only as an envelope whose
 * source is on that list and is not the actor (opts.actor; 'actor', 'agent', 'self', a missing source): anything else is
 * treated as absent, so the model takes its conservative path. The log row keeps the provenance and the rejected claims.
 *
 * Outcomes: every logged evaluation has a decisionId. outcome(decisionId, { result: good|bad, by, note }) records how it
 * turned out (company/work/decision-outcomes.jsonl); join() finds outcomes in later records (an owner reply that undoes
 * the decision, a credit note or refund in the ledger, a breached commitment, each naming the decisionId). health()
 * reports per model and version the precision of proceed decisions over the model's rolling window and, with apply,
 * demotes a live version to shadow when bad outcomes exceed model.outcomes.maxBad (closed default 0), telling the owner.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const co = require('./company');

const OPS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'regex', 'exists'];
const TYPES = ['string', 'number', 'boolean', 'array'];
const MODES = ['shadow', 'live'];
const ACTOR_SOURCES = ['actor', 'agent', 'self', 'caller', 'claimed', 'seat'];
const ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
const VER_RE = /^[0-9]+(\.[0-9]+){0,2}$/;

const rootOf = opts => path.resolve((opts && opts.root) || process.env.DECISION_ROOT || co.ROOT);
const FRAMEWORK_MODELS = co.p('company', 'decision-models');
function files(opts) {
  const r = rootOf(opts);
  return { root: r, models: path.join(r, 'company', 'decision-models'), packs: path.join(r, 'company', 'state', 'packs', 'installed'),
    state: path.join(r, 'company', 'state', 'decision-models.json'), stateLog: path.join(r, 'company', 'state', 'decision-models-log.jsonl'),
    logDir: path.join(r, 'company', 'work', 'decisions'), lockedExtra: path.join(r, 'company', 'state', 'locked-extra.json'),
    decisions: path.join(r, 'company', 'work', 'decisions.md'), outcomes: path.join(r, 'company', 'work', 'decision-outcomes.jsonl'),
    ownerInbound: path.join(r, 'company', 'owner', 'inbound.jsonl'), ledger: path.join(r, 'company', 'work', 'ledger', 'ledger.jsonl'),
    commitments: path.join(r, 'company', 'work', 'commitments') };
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
    if (s && 'safety' in s && typeof s.safety !== 'boolean') out.push('input ' + k + ': safety is true or false');
    if (s && s.safety && (!Array.isArray(s.sources) || !s.sources.length || !s.sources.every(x => typeof x === 'string' && x.trim() && !ACTOR_SOURCES.includes(x.trim().toLowerCase()))))
      out.push('input ' + k + ': a safety input lists the sources allowed to vouch for it (never the actor)');
  }
  if (m.outcomes !== undefined) {
    const o = m.outcomes;
    if (!o || typeof o !== 'object') out.push('outcomes must be an object');
    else {
      if ('windowDays' in o && !(typeof o.windowDays === 'number' && o.windowDays > 0)) out.push('outcomes.windowDays must be a positive number');
      if ('maxBad' in o && !(typeof o.maxBad === 'number' && o.maxBad >= 0)) out.push('outcomes.maxBad must be a number >= 0');
      if ('proceedActions' in o && !(Array.isArray(o.proceedActions) && o.proceedActions.every(a => (m.actions || []).includes(a)))) out.push('outcomes.proceedActions must be actions of the model');
    }
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
/* Provenance: unwrap {value, source, ref} envelopes; drop a safety fact whose source is missing, the actor, or not allowed. */
const isEnv = v => !!v && typeof v === 'object' && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, 'value');
function sourceRefusal(spec, src, actor) {
  const s = String(src == null ? '' : src).trim().toLowerCase();
  if (!s) return 'no source';
  const a = String(actor == null ? '' : actor).trim().toLowerCase();
  if (ACTOR_SOURCES.includes(s) || (a && [a, 'seat:' + a, 'agent:' + a, 'actor:' + a].includes(s))) return 'the source is the actor';
  const ok = (spec.sources || []).some(x => { x = String(x).trim().toLowerCase(); return x.endsWith('*') ? s.startsWith(x.slice(0, -1)) : s === x; });
  return ok ? null : 'source ' + s + ' is not one of ' + (spec.sources || []).join(', ');
}
function unwrap(m, input, actor) {
  const flat = {}, provenance = {}, distrusted = [], claims = {};
  input = input && typeof input === 'object' ? input : {};
  for (const k of Object.keys(input)) {
    const raw = input[k]; const spec = (m.inputs || {})[k]; const env = isEnv(raw);
    const v = env ? raw.value : raw;
    if (env) { provenance[k] = { source: raw.source == null ? null : String(raw.source) }; if (raw.ref != null) provenance[k].ref = String(raw.ref).slice(0, 300); }
    if (spec && spec.safety) {
      const why = env ? sourceRefusal(spec, raw.source, actor) : 'no provenance';
      if (why) { distrusted.push(k); provenance[k] = Object.assign(provenance[k] || { source: null }, { rejected: why }); if (v !== undefined && v !== null) claims[k] = v; continue; }
    }
    flat[k] = v;
  }
  return { flat, provenance, distrusted, claims };
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
function run(m, input, params, actor) {
  const u = unwrap(m, input, actor);
  const s = sanitize(m, u.flat);
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
  if (u.distrusted.length) out.distrusted = u.distrusted;
  return { out, values: s.values, provenance: u.provenance, claims: u.claims };
}
function evaluate(id, input, opts) {
  opts = opts || {};
  const L = load(id, opts.version, opts);
  if (!L.model || L.error) return { action: null, error: L.error, mode: 'shadow', model: { id, version: L.version || null, sha: L.sha || null } };
  const params = paramsFor(L.model, opts);
  const { out, values, provenance, claims } = run(L.model, input, params, opts.actor);
  const mode = modeFor(id, L.version, L.model, opts, L.sha);
  const res = Object.assign(out, { mode, model: { id, version: L.version, sha: L.sha } });
  if (opts.log !== false) {
    const at = new Date().toISOString();
    const isSens = k => !!((L.model.inputs[k] || {}).sensitive);
    const redacted = Object.keys(values).filter(isSens);
    const kept = {}; for (const k of Object.keys(values)) if (!redacted.includes(k)) kept[k] = values[k];
    const claimed = {}; for (const k of Object.keys(claims)) if (!isSens(k)) claimed[k] = claims[k];
    res.decisionId = 'd-' + sha(at + canon(values) + process.pid + Math.random()).slice(0, 12);
    const row = { at, decisionId: res.decisionId, id, version: L.version, sha: L.sha, mode, inputDigest: sha(canon(values)).slice(0, 16), input: kept,
      redacted: redacted.length ? redacted : undefined, provenance: Object.keys(provenance).length ? provenance : undefined,
      claimed: Object.keys(claimed).length ? claimed : undefined, actor: opts.actor || undefined,
      params, output: { action: res.action, rule: res.rule, score: res.score, distrusted: res.distrusted }, caller: opts.caller || undefined };
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
// a logged row back into evaluate() input: values with their recorded provenance, rejected claims as they were made
function replayInput(r) {
  const inp = {}; const pv = r.provenance || {};
  const put = (k, v) => { const p = pv[k]; inp[k] = p && !(p.rejected === 'no provenance') ? Object.assign({ value: v, source: p.source }, p.ref ? { ref: p.ref } : {}) : v; };
  for (const [k, v] of Object.entries(r.input || {})) put(k, v);
  for (const [k, v] of Object.entries(r.claimed || {})) put(k, v);
  return inp;
}
function replay(id, version, opts) {
  opts = opts || {};
  const L = load(id, version, opts); if (L.error) return { ok: false, error: L.error };
  const from = opts.from ? Date.parse(opts.from) : null;
  const rows = logRows(id, opts).filter(r => r.id === id && (!from || Date.parse(r.at) >= from));
  const dis = []; let agree = 0, partial = 0;
  for (const r of rows) {
    const { out } = run(L.model, replayInput(r), Object.assign(paramsFor(L.model, opts), r.params || {}), r.actor);
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
  // a case may name the versions it is for (`versions: ["1"]`): the others skip it
  const results = c.cases.filter(k => !Array.isArray(k.versions) || k.versions.map(String).includes(L.version)).map((k, i) => {
    const defaults = {}; for (const [n, s] of Object.entries(L.model.params || {})) defaults[n] = s.default;
    const { out } = run(L.model, k.input, Object.assign(defaults, k.params || {}), k.actor);   // cases see the closed defaults, not the owner's settings
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
  if (!require('./owner').shell()) return 'only the owner does this, ' + require('./owner').REASON;
  return null;
}
function recordOwner(opts, by, what, s, auto) {
  const f = files(opts); const at = new Date().toISOString();
  s._doc = 'Which version of each decision model is live, and the owner-set params. Written only by company/tools/decide.js promote|set-param --by <owner>, and by its automatic demotion to shadow when a live version has too many bad outcomes; watched by locked-watch.js (company/state/locked-extra.json).';
  writeAtomic(f.state, JSON.stringify(s, null, 2) + '\n');
  append(f.stateLog, JSON.stringify(Object.assign({ at, by }, what)) + '\n');
  if (!fs.existsSync(f.decisions)) append(f.decisions, '# Decisions\n\n');
  const lp = co.localParts(new Date(at));
  append(f.decisions, '- ' + lp.date + ' ' + lp.time + ' ' + by + (auto ? ' ' : ' (owner) ') + what.text + ' (company/tools/decide.js)\n');
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
  { p: 'company/work/decision-outcomes.jsonl', cls: 'A', append: true, writers: ['decide.js'], owner: 'risk', area: 'record', why: 'how each decision turned out (decide.js outcome, and the automatic join)' },
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

/* ---------- outcomes: decision -> how it turned out; precision; auto-demotion ---------- */
const DID_RE = /\bd-[0-9a-f]{12}\b/g;
const readRows = file => { let t = ''; try { t = fs.readFileSync(file, 'utf8'); } catch (_) { return []; } const o = []; for (const l of t.split('\n')) { if (!l.trim()) continue; try { o.push(JSON.parse(l)); } catch (_) {} } return o; };
function findDecision(decisionId, opts) {
  for (const id of ids(opts)) for (const r of logRows(id, opts)) if (r.decisionId === decisionId) return r;
  return null;
}
function outcomes(opts) { return readRows(files(opts).outcomes); }
const proceedActions = m => (m && m.outcomes && Array.isArray(m.outcomes.proceedActions)) ? m.outcomes.proceedActions : ((m && m.actions) || []).filter(a => a !== (m.default || {}).action);
/* outcome(decisionId, { result, by, note, source?, ref? }): a person (or the join) says how a decision turned out. */
function outcome(decisionId, o, opts) {
  o = o || {};
  if (!['good', 'bad'].includes(o.result)) return { ok: false, code: 2, error: '--result good|bad' };
  const by = String(o.by || '').trim(); if (!by) return { ok: false, code: 2, error: '--by <seat|owner> is required' };
  const d = findDecision(String(decisionId || ''), opts); if (!d) return { ok: false, code: 2, error: 'no logged decision ' + decisionId };
  if (isOwnerName(by) && !o.source && underStation()) return { ok: false, code: 3, error: 'an agent run cannot record an outcome as the owner' };
  if (o.result === 'good' && d.actor && String(d.actor).trim().toLowerCase() === by.toLowerCase()) return { ok: false, code: 3, error: 'the seat that acted on a decision does not grade it good' };
  const row = { at: new Date().toISOString(), decisionId: d.decisionId, id: d.id, version: d.version, action: (d.output || {}).action, mode: d.mode,
    result: o.result, by, note: o.note ? String(o.note).slice(0, 500) : undefined, source: o.source || 'manual', ref: o.ref || undefined };
  append(files(opts).outcomes, JSON.stringify(row) + '\n');
  const h = o.noHealth ? null : health(Object.assign({}, opts, { apply: true, id: d.id, noJoin: true }));
  return { ok: true, outcome: row, demoted: h ? h.demoted : [] };
}
/* join(): outcomes that later records already answer. Each names the decisionId it answers. Idempotent. */
function join(opts) {
  const f = files(opts); const have = new Set(outcomes(opts).map(r => r.decisionId + '|' + r.source + '|' + (r.ref || '')));
  const found = [];
  const add = (did, source, ref, by, note) => { const k = did + '|' + source + '|' + (ref || ''); if (have.has(k)) return; have.add(k); found.push({ did, source, ref, by, note }); };
  const UNDO = /\b(undo|undone|revert|reverse|roll ?back|cancel|not ok|no\b|stop)/i;
  for (const m of readRows(f.ownerInbound)) {
    const text = String(m.text != null ? m.text : (m.body || ''));
    const dids = new Set((text.match(DID_RE) || []).concat(String(m.re || '').match(DID_RE) || []));
    for (const did of dids) if (UNDO.test(text.replace(DID_RE, ''))) add(did, 'owner-reversal', m.id || m.at, 'owner', text.slice(0, 200));
  }
  for (const r of readRows(f.ledger)) {
    if (!['credit-note', 'refund'].includes(r.type)) continue;
    for (const did of new Set(JSON.stringify(r).match(DID_RE) || [])) add(did, 'ledger:' + r.type, r.hash || r.seq || r.at, r.by || 'ledger', r.reason || r.note);
  }
  let cs = []; try { cs = fs.readdirSync(f.commitments).filter(x => x.endsWith('.json')); } catch (_) {}
  for (const x of cs) {
    const c = readJson(path.join(f.commitments, x), null); if (!c || c.state !== 'breached') continue;
    for (const did of new Set(JSON.stringify(c).match(DID_RE) || [])) add(did, 'commitment-breached', c.id || x, 'commitments', c.title);
  }
  const rec = [];
  for (const j of found) { const r = outcome(j.did, { result: 'bad', by: j.by, note: j.note, source: j.source, ref: String(j.ref || ''), noHealth: true }, opts); if (r.ok) rec.push(r.outcome); }
  return { ok: true, recorded: rec };
}
function demote(id, version, why, opts) {
  const s = state(opts); const pr = s.models[id];
  if (!pr || String(pr.version) !== String(version) || pr.mode !== 'live') return null;
  const at = new Date().toISOString();
  s.models[id] = Object.assign({}, pr, { mode: 'shadow', demoted: { at, why, from: 'live' } });
  const text = 'demoted decision model ' + id + ' v' + version + ' from live to shadow: ' + why;
  recordOwner(opts, 'decide.js (automatic)', { op: 'demote', id, version, why, text }, s, true);
  try {
    require('./governance').notify('Decision model ' + id + ' v' + version + ' is back in shadow mode: ' + why + '. Until you promote it again (node company/tools/decide.js promote ' + id + ' ' + version + ' --mode live --by owner), every ' + id + ' question comes to you.', { root: rootOf(opts) });
  } catch (_) {}
  return { id, version, why };
}
/* health({ id?, apply?, now? }): per model and version, proceed decisions in the window, judged good/bad, precision. */
function health(opts) {
  opts = opts || {};
  const joined = opts.noJoin ? null : join(opts);
  const now = opts.now ? Date.parse(opts.now) : Date.now();
  const outs = {}; for (const o of outcomes(opts)) (outs[o.decisionId] = outs[o.decisionId] || []).push(o);
  const models = []; const demoted = [];
  for (const id of (opts.id ? [opts.id] : ids(opts))) {
    const pr = state(opts).models[id] || null;
    const byV = {};
    for (const r of logRows(id, opts)) { if (!r.decisionId) continue; (byV[r.version] = byV[r.version] || []).push(r); }
    for (const v of Object.keys(byV).sort(cmpVer)) {
      const L = load(id, v, opts); const m = L.model || {};
      const cfg = Object.assign({ windowDays: 30, maxBad: 0 }, m.outcomes || {});
      const from = now - cfg.windowDays * 86400000;
      const pro = proceedActions(m);
      const rows = byV[v].filter(r => Date.parse(r.at) >= from && pro.includes((r.output || {}).action));
      let good = 0, bad = 0; const badIds = [];
      for (const r of rows) { const os = outs[r.decisionId] || []; if (!os.length) continue; if (os.some(o => o.result === 'bad')) { bad++; badIds.push(r.decisionId); } else good++; }
      const live = !!(pr && String(pr.version) === v && pr.mode === 'live');
      const row = { id, version: v, live, windowDays: cfg.windowDays, maxBad: cfg.maxBad, proceed: rows.length, judged: good + bad, good, bad,
        precision: good + bad ? +(good / (good + bad)).toFixed(3) : null, badDecisions: badIds.slice(-10) };
      if (live && bad > cfg.maxBad) {
        row.overThreshold = true;
        if (opts.apply) { const d = demote(id, v, bad + ' bad outcome(s) on proceed decisions in ' + cfg.windowDays + ' days (limit ' + cfg.maxBad + '; ' + badIds.slice(-3).join(', ') + ')', opts); if (d) { demoted.push(d); row.live = false; row.demoted = true; } }
      }
      models.push(row);
    }
  }
  return { ok: true, at: new Date(now).toISOString(), joined: joined ? joined.recorded.length : 0, models, demoted };
}
function params(id, opts) { const L = load(id, null, opts); return L.model && !L.error ? paramsFor(L.model, opts) : {}; }

module.exports = { outcome, outcomes, join, health, demote, findDecision, params, unwrap, ACTOR_SOURCES, OPS, MODES, files, ids, versions, activeVersion, load, validate, evaluate, run, replay, test: runCases, cases, promote, setParam, register, list, logRows, state, LOCKED, canon };
