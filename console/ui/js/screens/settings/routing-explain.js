// Plain words for Settings › Models › Cheaper models (routing.js beside this file), for a non-technical owner: what a
// trial compares ("Comparing three Claude models on coding work"), how far it got ("2 of 90 results so far"), when it
// pauses itself, and the Start dialog's text. Model ids, arms, the entry share and the provider keys appear only under
// "Technical details (for the crew)" (technicalLines). Pure (no DOM), so company/tools/tests/routing-controls.test.js
// checks the wording. t.heldGuard comes from `routing.js status --json`: { providers (the trial's pauseWhenHeld),
// subscriptions (its arms' providers the pacer meters as subscriptions), missing (subscriptions an arm runs on that do
// not pause it) }.
export const PNAME = { 'claude-cli': 'Claude', custom: 'MiniMax', deepseek: 'DeepSeek' };
const pname = p => PNAME[p] || p;
const or = xs => xs.length <= 1 ? (xs[0] || '') : xs.slice(0, -1).join(', ') + ' or ' + xs[xs.length - 1];
const and = xs => xs.length <= 1 ? (xs[0] || '') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];
const NUM = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
// the task classes (company/tools/lib/taskclass.js) in everyday words
export const CLASS_SAY = { code: 'coding', review: 'reviewing', research: 'research', writing: 'writing', design: 'design', ops: 'running the company', mechanical: 'routine', general: 'general' };

export function heldLine(t) {
  const g = (t && t.heldGuard) || { providers: (t && t.pauseWhenHeld) || [], missing: [] };
  const held = (g.providers || []).map(pname), miss = (g.missing || []).map(pname);
  const base = held.length ? 'Pauses itself while the ' + or(held) + ' plan is at its limit.' : 'Never pauses for a plan limit.';
  return miss.length ? base + ' Warning: it keeps going when the ' + or(miss) + ' plan is at its limit, though one of its models uses ' + (miss.length > 1 ? 'those plans' : 'that plan') + '.' : base;
}

/* "Comparing three Claude models on coding work" / "Comparing Claude and MiniMax models on writing work" */
export function trialTitle(t) {
  const arms = (t && t.arms) || [];
  const provs = [...new Set(arms.map(a => pname(a.provider)))];
  const n = arms.length;
  const what = provs.length === 1 ? (NUM[n] || String(n)) + ' ' + provs[0] + ' models' : and(provs) + ' models';
  return 'Comparing ' + what + ' on ' + (CLASS_SAY[t && t.class] || 'one kind of') + ' work';
}
/* "2 of 90 results so far" (each model needs its share before the comparison is fair) */
export function progressLine(t) {
  const arms = (t && t.arms) || [];
  const min = (t && t.progress && t.progress.minItemsPerArm) || (t && t.minItemsPerArm) || 0;
  const got = arms.reduce((s, a) => s + (Number(a.items) || 0) + (Number(a.shadowItems) || 0), 0);
  const need = min * arms.length;
  return need ? got + ' of ' + need + ' results so far' : got + ' results so far';
}
/* why a trial is not moving right now, in plain words (the raw reasons go under Technical details) */
export function waitingLine(t) {
  if (!t) return null;
  if (t.status === 'paused') return 'Paused' + (t.pausedBy && !/^owner$/i.test(t.pausedBy) ? ' by ' + t.pausedBy : ' by you') + '.';
  if (t.status === 'running' && t.hold) return 'Waiting: a plan one of its models uses is at its limit. It carries on by itself.';
  return null;
}
/* the technical part, for the crew: each arm's provider/model@effort and items, the entry share, the trial id */
export function technicalLines(t) {
  const arms = (t && t.arms) || [];
  return ['Trial ' + (t && t.id) + ' · class ' + (t && t.class) + ' · entry share ' + Math.round(((t && t.entryShare) || 0) * 100) + '%' + (t && t.minItemsPerArm ? ' · ' + t.minItemsPerArm + ' items per arm' : '')]
    .concat(arms.map((a, i) => 'arm ' + (a.index != null ? a.index : i) + ': ' + a.provider + '/' + a.model + (a.effort ? '@' + a.effort : '') + ' · ' + (a.items || 0) + ' items' + (a.shadowItems ? ' + ' + a.shadowItems + ' recorded only' : '')))
    .concat(((t && t.reasons) || []).map(r => 'status: ' + r));
}

export function startBody(t, where, shadow) {
  const n = ((t && t.arms) || []).length;
  return 'Some of the ' + (CLASS_SAY[t && t.class] || '') + ' work in ' + (where || 'its part of the company') + ' is shared out evenly between the ' + (NUM[n] || n) + ' models being compared, so the crew can see which does it best for the money.' +
    (shadow ? ' Cheaper models are set to watching only, so nothing changes until you switch them on.' : '') + ' ' + heldLine(t).replace(/^Pauses itself/, 'It pauses itself').replace(/^Never pauses/, 'It never pauses');
}

// Weekly suggestions (routing.js proposals, docs/ROUTING.md "Weekly suggestions"): the switch and what happened to each
// suggestion, in plain words. The provider and model ids stay under "Technical details (for the crew)" (suggestionTech).
export const SUGGEST_SAY = {
  off: ['Off', 'neutral', 'The crew does not suggest changes to which setup does each kind of work.'],
  shadow: ['Recording only', 'warning', 'Each week the crew notes which setup it would suggest for each kind of work, and changes nothing.'],
  live: ['On', 'online', 'Each week the crew may suggest a cheaper or better setup for one kind of work. You get a card; it goes ahead unless you keep things as they are.'],
};
const STATE_SAY = { applied: 'it went ahead', vetoed: 'you kept it as it was', skipped: 'not suggested', 'waiting for the veto window': 'waiting: it goes ahead unless you keep it as it is', 'waiting for the CEO': 'waiting for the CEO first', 'answered by the CEO': 'the CEO answered; your card follows' };
const SKIP_SAY = { 'mode shadow': 'recording only', 'tier step': 'too big a jump at once', 'ceo declined': 'the CEO said no', superseded: 'replaced by a newer look', 'route changed': 'the setup changed in the meantime', 'class rules': 'that kind of work may not run there', 'not enough items': 'not enough finished jobs yet', 'one move per department and class a week': 'one change a week is enough', 'over the weekly limit': 'over this week\'s limit' };
// "Engineering's coding work: it went ahead."
export function suggestionLine(x) {
  const what = (x.deptName || 'One team') + '\'s ' + (CLASS_SAY[x.class] || 'other') + ' work';
  const st = STATE_SAY[x.state] || 'noted';
  return what + ': ' + st + (x.state === 'skipped' && SKIP_SAY[x.why] ? ' (' + SKIP_SAY[x.why] + ')' : '') + '.';
}
export const weekTitle = (w, n) => 'Week ' + String(w || '').replace(/^\d{4}-W0?/, '') + ': ' + (n ? n + (n === 1 ? ' suggestion' : ' suggestions') : 'nothing to suggest');
export const suggestionTech = x => (x.id || '?') + ' ' + (x.dept || '?') + '/' + (x.class || '?') + ': ' + (x.from ? x.from.provider + '/' + x.from.model + (x.from.effort ? '@' + x.from.effort : '') : '?') + ' -> ' + (x.to ? x.to.provider + '/' + x.to.model + (x.to.effort ? '@' + x.to.effort : '') : '?') + ' · ' + x.state + (x.why ? ' (' + x.why + ')' : '');
export function suggestionSamples() {
  const base = { deptName: 'Engineering', class: 'code' };
  return Object.values(SUGGEST_SAY).flatMap(x => [x[0], x[2]]).concat(Object.keys(STATE_SAY).map(state => suggestionLine(Object.assign({ state }, base))), Object.keys(SKIP_SAY).map(why => suggestionLine(Object.assign({ state: 'skipped', why }, base))), [weekTitle('2026-W48', 2), weekTitle('2026-W07', 1), weekTitle('2026-W12', 0)]);
}
