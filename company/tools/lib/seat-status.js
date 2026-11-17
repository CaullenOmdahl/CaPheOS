'use strict';
/* seat-status.js (lib) — why each seat is or is not working, in plain words, from the dispatcher's last tick.
 *
 * dispatch.js decides once per tick, per seat, whether to wake it and why not. It writes that decision into
 * company/work/dispatch-state.json `seats` so Today can say it instead of "X is idle; next run …":
 *   seats.<id> = { state, reason, waitingOn: [names], since, qid? }
 * state is one of: working · started · held-money · waiting · stuck · resting · held · idle
 * `since` is when this state and reason began (kept across ticks while they stay the same).
 *
 *   entry(o)            {state, reason, waitingOn, qid?} for one decision (pure: tested in sprint.test.js)
 *   carry(prev, next, nowIso)   keep `since` while state and reason are unchanged
 */
const list = a => a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
const items = n => n + ' item' + (n === 1 ? '' : 's');

/* entry({ state, kind?, waiting?: [names], waits?: {name: n}, ceoName?, open?, runs?, at?, why? }) */
function entry(o) {
  const w = o.waiting || [];
  const waitOn = Object.entries(o.waits || {}).sort((a, b) => b[1] - a[1]);
  const on = waitOn.map(([n]) => n);
  switch (o.state) {
    case 'working': return { state: 'working', reason: 'working', waitingOn: [] };
    case 'started': return { state: 'started', reason: 'started this tick' + (o.why ? ' for ' + o.why : ''), waitingOn: [] };
    case 'held-money': {
      const who = w.length ? ' — ' + list(w) + (w.length > 1 ? ' are' : ' is') + ' waiting on it' : '';
      const head = o.kind === 'spread' ? 'paused to make today\'s budget last' : o.kind === 'perAgent' ? 'paused: its share of today\'s metered budget is spent' : 'paused: today\'s metered budget is spent';
      return { state: 'held-money', kind: o.kind, reason: head + who, waitingOn: [], qid: o.qid || null };
    }
    case 'waiting':
      return { state: 'waiting', reason: 'waiting on ' + (waitOn.length === 1 ? waitOn[0][0] + ' for ' + items(waitOn[0][1]) : waitOn.map(([n, c]) => n + ' (' + c + ')').join(', ')), waitingOn: on };
    case 'stuck':
      return { state: 'stuck', reason: 'stuck — same ' + items(o.open || 0) + ' after ' + (o.runs || 3) + ' runs; ' + (o.ceoName || 'the CEO') + ' has been asked', waitingOn: [o.ceoName || 'the CEO'] };
    case 'resting':
      return { state: 'resting', reason: (o.changed ? 'resting after its last run' : 'nothing new since its last run') + (o.at ? '; looks again at ' + o.at : ''), waitingOn: on };
    case 'held': return { state: 'held', reason: o.why || 'held', waitingOn: [] };
    default: return { state: 'idle', reason: on.length ? 'waiting on ' + list(on) : 'waiting for new work', waitingOn: on };
  }
}
function carry(prev, next, nowIso) {
  const same = prev && prev.state === next.state && prev.reason === next.reason;
  return Object.assign({}, next, { since: same && prev.since ? prev.since : nowIso });
}

module.exports = { entry, carry };
