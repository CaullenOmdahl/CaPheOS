// Live updates: SSE at /api/events (`event: change`, data {topic}). Poll fallback every 15 s while SSE is down.
const subs = new Set();
let es = null, live = false, pollTimer = null;

export function on(topics, fn) {
  const s = { topics: new Set([].concat(topics)), fn };
  subs.add(s);
  return () => subs.delete(s);
}
// onLive(): delivered at once even while the owner edits, for a subscriber that only appends (a meeting's messages and
// its speaking-now line) and never redraws a control. Anything that redraws a dropdown or a field uses on().
export function onLive(topics, fn) {
  const s = { topics: new Set([].concat(topics)), fn, live: true };
  subs.add(s);
  return () => subs.delete(s);
}
// While the owner is using a control in the main area (an open dropdown, a field with the cursor in it), a live update
// must not redraw the screen under them: it closes the dropdown and drops what they typed. Updates for that time are held
// (one per subscriber, the latest topic wins) and delivered as soon as focus leaves the control.
const held = new Map();
function editing() {
  const a = typeof document !== 'undefined' ? document.activeElement : null;
  if (!a || a === document.body) return false;
  if (!/^(SELECT|INPUT|TEXTAREA)$/.test(a.tagName) && !a.isContentEditable) return false;
  return !!(a.closest && a.closest('main'));
}
function run(s, topic) { try { s.fn(topic); } catch (e) { console.error(e); } }
function fire(topic) {
  const now = editing();
  for (const s of [...subs]) if (topic === '*' || s.topics.has(topic) || s.topics.has('*')) {
    if (now && !s.live) held.set(s, held.has(s) && held.get(s) !== topic ? '*' : topic); else run(s, topic);
  }
}
function flush() {
  if (!held.size || editing()) return;
  const all = [...held]; held.clear();
  for (const [s, topic] of all) if (subs.has(s)) run(s, topic);
}
if (typeof document !== 'undefined') {
  // focusout fires before the next element takes focus: check once focus has settled
  document.addEventListener('focusout', () => setTimeout(flush, 0));
  document.addEventListener('change', () => setTimeout(flush, 0));
}
export function pendingWhileEditing() { return held.size; }
export const _test = { fire, flush };   // unit tests (company/tools/tests/live-events.test.js)
export function isLive() { return live; }

export function start() {
  connect();
  pollTimer = setInterval(() => { if (!live && !document.hidden) fire('*'); }, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !live) fire('*'); });
}
function connect() {
  if (typeof EventSource === 'undefined') return;
  try { es = new EventSource('/api/events', { withCredentials: true }); } catch (_) { return; }
  es.onopen = () => { live = true; document.dispatchEvent(new CustomEvent('capheos:live', { detail: true })); };
  es.onerror = () => { live = false; document.dispatchEvent(new CustomEvent('capheos:live', { detail: false })); };
  es.addEventListener('change', ev => {
    let t = '*'; try { t = JSON.parse(ev.data).topic || '*'; } catch (_) {}
    fire(t);
  });
}
