#!/usr/bin/env node
/* escalate.js — record a block and get the company's sanctioned next route.
 *
 * A refusal is data. This logs it (append-only) and tells the caller what the Escalation Policy allows:
 *   T1 capacity    -> retry after backoff / rotate credential
 *   T2 capability  -> split the task or reassign to another model
 *   T3 policy      -> COMMANDER DECISION. Never auto-route; never reword to bypass.
 *   T4 subscription-> shift to a seat or contractor on another model family, same context
 *
 * usage:
 *   node company/tools/escalate.js --agent Alex --model <model-id> --class T3 \
 *        --task "summarise the refund clause" --reason "model declined: content policy"
 *   node company/tools/escalate.js ... --verbatim "<exact text>" --route auto
 * exit 0 always when the log was written (the policy, not the exit code, carries the decision).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const co = require('./lib/company');
const ROOT = co.ROOT;
const LOG = co.p('company', 'escalations.jsonl');

function args() {
  const out = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const k = a[i].slice(2);
    const v = (a[i + 1] !== undefined && !a[i + 1].startsWith('--')) ? a[++i] : true;
    out[k] = v;
  }
  return out;
}

const CLS = {
  T1: { name: 'capacity', route: 'retry', why: 'transient: retry with backoff or rotate the credential; no human needed' },
  T2: { name: 'capability', route: 'reassign', why: 'split the task smaller or reassign to another model; the CEO re-dispatches' },
  T3: { name: 'policy_refusal', route: 'commander', why: 'STOP. Do not reword to bypass. The CEO reassigns the legitimate adjacent work or escalates a decision to the Commander' },
  T4: { name: 'subscription_limit', route: 'fleet_shift', why: 'move to a seat or contractor on another model family for the duration (company/MODEL_POLICY.md; the people owner picks); same context, different family' },
};
const ROUTES = {
  T1: [{ action: 'retry_same_model', after_ms: 30000 }],
  T2: [{ action: 'split_task' }, { action: 'reassign', to: 'other_family', decidedBy: 'people' }],
  T3: [{ action: 'commander_decision', auto_route: false }],
  T4: [{ action: 'reassign', to: 'other_family', decidedBy: 'people' }, { action: 'reassign_contractor', decidedBy: 'people' }],
};

const a = args();
const cls = String(a['class'] || '').toUpperCase();
if (!CLS[cls]) {
  console.log(JSON.stringify({ ok: false, error: '--class must be one of T1 T2 T3 T4' }));
  process.exit(2);
}
const task = String(a.task || '').trim();
if (!task) {
  console.log(JSON.stringify({ ok: false, error: '--task is required' }));
  process.exit(2);
}
const event = {
  at: new Date().toISOString(),
  class: cls,
  class_name: CLS[cls].name,
  agent: String(a.agent || 'unknown'),
  model: String(a.model || 'unknown'),
  task,
  task_id: crypto.createHash('sha256').update(task).digest('hex').slice(0, 12),
  reason: String(a.reason || ''),
  verbatim: a.verbatim === true ? '' : String(a.verbatim || ''),
  route: CLS[cls].route,
  routes: ROUTES[cls],
  policy: CLS[cls].why,
};
try {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, JSON.stringify(event) + '\n');
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: 'could not write escalation log: ' + e.message }));
  process.exit(1);
}
const counts = {};
try {
  for (const line of fs.readFileSync(LOG, 'utf8').trim().split('\n')) {
    if (!line) continue;
    try { const j = JSON.parse(line); counts[j.class] = (counts[j.class] || 0) + 1; } catch (_) {}
  }
} catch (_) {}
console.log(JSON.stringify({
  ok: true,
  logged: path.relative(ROOT, LOG),
  event: { class: cls, class_name: CLS[cls].name, agent: event.agent, task_id: event.task_id },
  next: CLS[cls].why,
  routes: ROUTES[cls],
  totals: counts,
  handoff: 'BLOCKED · ' + cls + ' · ' + event.model + ' · ' + (event.reason || CLS[cls].name),
}, null, 1));
