'use strict';
/* apprentice/adapter.js — the ONLY place that knows the apprentice server's wire shapes (docs/APPRENTICE.md "Assumed
 * API shapes"). Every shape here is a guess until it is checked against the live server; the readers are tolerant (they
 * take several field names) so a different spelling on the server needs one edit here, nowhere else.
 *
 *   const A = require('./adapter')
 *   A.paths(cfg)                       -> { health, ready, models, chat, trajectories(t), study(t), units(t), promote(t,u), rollback(t,u), exportUnit(t,u) }
 *   A.modelId(cfg)                     -> "<namespace>/<tenant>"           the live model id on the wire
 *   A.candidateModel(cfg, unitId)      -> "<namespace>/<tenant>@<unitId>"  (cfg.candidateTarget 'model-suffix', the default)
 *   A.chatBody(model, messages, o)     -> the chat request body (never tools: no tools, tool_choice or functions key)
 *   A.chatReply(json | sseText)        -> { text, tokensIn, tokensOut, servedModel }
 *   A.trajectoryBody(lesson)           -> the body that submits one lesson
 *   A.studyBody(o) / A.studyReply(j)   -> { unitId, status }
 *   A.unitsReply(j)                    -> [{ id, status, live, candidate, raw }]
 *   A.decisionBody(o)                  -> the promote / rollback body (who approves: the external gate, never the model)
 * Pure: no network, no fs.
 */
const SAFE_ID = /^[A-Za-z0-9._:@-]{1,128}$/;
const safeId = (x, what) => { const s = String(x == null ? '' : x); if (!SAFE_ID.test(s)) throw new Error('unsafe ' + (what || 'id') + ' for the apprentice api'); return encodeURIComponent(s); };

function paths(cfg) {
  const ns = safeId((cfg && cfg.namespace) || 'apprentice', 'namespace');
  const base = t => '/v1/' + ns + '/tenants/' + safeId(t, 'tenant');
  return {
    health: '/healthz', ready: '/readyz', models: '/v1/models', chat: '/v1/chat/completions',
    trajectories: t => base(t) + '/trajectories',
    study: t => base(t) + '/study',
    units: t => base(t) + '/units',
    promote: (t, u) => base(t) + '/units/' + safeId(u, 'unit id') + '/promote',
    rollback: (t, u) => base(t) + '/units/' + safeId(u, 'unit id') + '/rollback',
    exportUnit: (t, u) => base(t) + '/units/' + safeId(u, 'unit id') + '/export-capheos',
  };
}
const modelId = cfg => String((cfg && cfg.namespace) || 'apprentice') + '/' + String(cfg && cfg.tenant || 'default');
function candidateModel(cfg, unitId) {
  if (cfg && cfg.candidateTarget === 'body-field') return modelId(cfg);
  return modelId(cfg) + '@' + String(unitId);
}

const FORBIDDEN = ['tools', 'tool_choice', 'functions', 'function_call', 'parallel_tool_calls'];
function chatBody(model, messages, o) {
  o = o || {};
  const body = { model: String(model), messages: (messages || []).map(m => ({ role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user', content: String(m.content == null ? '' : m.content) })),
    stream: false, temperature: 0 };
  if (o.maxTokens) body.max_tokens = Number(o.maxTokens);
  if (o.unitId && o.candidateTarget === 'body-field') body.unit_id = String(o.unitId);
  // what the call is for: a bench call asks the server not to learn from it (verify the field name on the live server)
  body.metadata = { purpose: String(o.purpose || 'shadow'), learn: false };
  for (const k of FORBIDDEN) delete body[k];
  return body;
}
const contentText = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => (p && (p.text || p.content)) || '').join('') : '';
function chatReply(x) {
  if (typeof x === 'string') {
    // a server-sent-events reply (stream:true, or a server that streams anyway): data: lines with deltas
    let text = '', served = null, usage = null;
    for (const line of x.split(/\r?\n/)) {
      const m = /^data:\s*(.*)$/.exec(line); if (!m || m[1] === '[DONE]') continue;
      let j; try { j = JSON.parse(m[1]); } catch (_) { continue; }
      const ch = j.choices && j.choices[0];
      if (ch && ch.delta) text += contentText(ch.delta.content);
      else if (ch && ch.message) text += contentText(ch.message.content);
      if (j.model) served = j.model; if (j.usage) usage = j.usage;
    }
    return { text, tokensIn: Number(usage && usage.prompt_tokens) || 0, tokensOut: Number(usage && usage.completion_tokens) || 0, servedModel: served };
  }
  const j = x || {};
  const ch = (j.choices && j.choices[0]) || {};
  const text = contentText(ch.message && ch.message.content) || (typeof ch.text === 'string' ? ch.text : '') || (typeof j.output_text === 'string' ? j.output_text : '');
  const u = j.usage || {};
  return { text, tokensIn: Number(u.prompt_tokens || u.input_tokens) || 0, tokensOut: Number(u.completion_tokens || u.output_tokens) || 0, servedModel: j.model || null };
}

/* one lesson: our record (task, teacher, student, score) plus the same as chat messages with a reward, the shape most
   learning servers take. Assumed; see the doc. */
function trajectoryBody(lesson) {
  const L = lesson || {};
  return { trajectories: [Object.assign({}, L, {
    messages: [{ role: 'user', content: String((L.task && L.task.prompt) || '') }, { role: 'assistant', content: String((L.teacher && L.teacher.answer) || '') }],
    reward: Number(L.score) || 0,
  })] };
}
const studyBody = o => ({ reason: String((o && o.reason) || 'scheduled'), requested_by: 'external-gate' });
const firstOf = (j, keys) => { for (const k of keys) { const v = k.split('.').reduce((a, p) => (a && typeof a === 'object' ? a[p] : undefined), j); if (v != null && v !== '') return v; } return null; };
function studyReply(j) {
  j = j && typeof j === 'object' ? j : {};
  const id = firstOf(j, ['unit_id', 'unitId', 'id', 'unit.id', 'unit.unit_id', 'candidate.id', 'candidate.unit_id']);
  return { unitId: id == null ? null : String(id), status: String(firstOf(j, ['status', 'state', 'unit.status', 'unit.state']) || '') .toLowerCase() || null };
}
const CANDIDATE = new Set(['candidate', 'pending', 'trained', 'ready', 'staged', 'awaiting-approval', 'awaiting_approval', 'proposed']);
const LIVE = new Set(['live', 'promoted', 'active', 'current', 'serving']);
function unitsReply(j) {
  const list = Array.isArray(j) ? j : (j && (j.units || j.data || j.items || j.results)) || [];
  return (Array.isArray(list) ? list : []).filter(u => u && typeof u === 'object').map(u => {
    const id = firstOf(u, ['unit_id', 'unitId', 'id']); const status = String(firstOf(u, ['status', 'state']) || '').toLowerCase();
    return { id: id == null ? null : String(id), status, live: u.live === true || u.is_live === true || LIVE.has(status), candidate: CANDIDATE.has(status), at: firstOf(u, ['created_at', 'createdAt', 'at']) };
  }).filter(u => u.id);
}
function decisionBody(o) {
  o = o || {};
  return { approved_by: 'external-gate', approver_kind: 'external', reason: String(o.reason || ''), evidence: o.evidence || null };
}
const refusedSelfApproval = status => status === 403;

module.exports = { paths, modelId, candidateModel, chatBody, chatReply, trajectoryBody, studyBody, studyReply, unitsReply, decisionBody, refusedSelfApproval, FORBIDDEN, SAFE_ID };
