// Live updates: SSE at /api/events (`event: change`, data {topic}). Poll fallback every 15 s while SSE is down.
const subs = new Set();
let es = null, live = false, pollTimer = null;

export function on(topics, fn) {
  const s = { topics: new Set([].concat(topics)), fn };
  subs.add(s);
  return () => subs.delete(s);
}
function fire(topic) {
  for (const s of [...subs]) if (topic === '*' || s.topics.has(topic) || s.topics.has('*')) { try { s.fn(topic); } catch (e) { console.error(e); } }
}
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
