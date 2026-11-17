// fetch wrapper for the console API (docs/CONSOLE-API.md). Cookie auth, JSON in and out.
// A failing station proxy call is marked `stationDown` so screens show "Station not running".

export async function api(path, opts = {}) {
  const init = { method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'), credentials: 'same-origin', headers: {} };
  if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
  if (opts.signal) init.signal = opts.signal;
  const isStation = path.startsWith('/station/');
  let res;
  try { res = await fetch('/api' + path, init); }
  catch (e) { throw mark(new Error('Console server not reachable'), isStation); }
  let data = null; const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = { ok: res.ok, text }; }
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error('Not signed in: sign in again on the login page'), { auth: true });
  if (!res.ok || (data && data.ok === false)) {
    const msg = (data && (data.error || data.text)) || res.status + ' ' + res.statusText;
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.status = res.status;
    if (isStation && (res.status === 502 || res.status === 503 || res.status === 504 || /station|ECONNREFUSED|not running|unreachable/i.test(err.message))) err.stationDown = true;
    throw err;
  }
  return data;
}
function mark(e, station) { if (station) e.stationDown = true; return e; }

export const post = (path, body) => api(path, { body: body || {} });

// POST that streams (run/stream). Calls onChunk(textDelta, rawEvent) as it goes. Resolves with the full text.
export async function stream(path, body, onChunk, signal) {
  const res = await fetch('/api' + path, { method: 'POST', credentials: 'same-origin', signal,
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(body) });
  if (!res.ok || !res.body) {
    let msg = res.status + ' ' + res.statusText; try { const j = await res.json(); msg = j.error || msg; } catch (_) {}
    const e = new Error(msg); e.status = res.status; if (res.status >= 502) e.stationDown = true; throw e;
  }
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '', full = '';
  const handle = line => {
    line = line.trim(); if (!line || line.startsWith(':') || line.startsWith('event:') || line.startsWith('id:')) return;
    const raw = line.startsWith('data:') ? line.slice(5).trim() : line;
    if (raw === '[DONE]') return;
    let ev; try { ev = JSON.parse(raw); } catch (_) { full += raw; onChunk(raw, null); return; }
    const d = deltaOf(ev);
    if (d) { full += d; onChunk(d, ev); } else onChunk('', ev);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
  }
  if (buf) handle(buf);
  return full;
}
export function deltaOf(ev) {
  if (!ev || typeof ev !== 'object') return '';
  // StarNet NDJSON: {name:'agent.token', payload:{delta}} (docs: sidecar ROUTES, POST /api/run)
  if (ev.payload && typeof ev.payload === 'object') return ev.name === 'agent.token' && typeof ev.payload.delta === 'string' ? ev.payload.delta : '';
  if (typeof ev.delta === 'string') return ev.delta;
  if (ev.delta && typeof ev.delta.text === 'string') return ev.delta.text;
  if (ev.type && /delta|token|text/.test(ev.type) && typeof ev.text === 'string') return ev.text;
  if (typeof ev.chunk === 'string') return ev.chunk;
  if (typeof ev.content === 'string' && (!ev.type || /delta|text|assistant/.test(ev.type))) return ev.content;
  return '';
}
