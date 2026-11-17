'use strict';
/* lib/gates.js — what the dispatcher looks at to decide whether a parked handoff item may start (company/HANDOFFS.md).
 * The rules themselves are pure and live in lib/sprint.js (parseDeps, resolveDeps, notBeforeGate); this file is the I/O
 * side: where a handoff, quest step, file, service run, watched job or seat item is found, the owner's "Start now"
 * releases, and the plain words the console shows.
 *
 *   G.lookups({ root, crew, quests, self })   the look functions lib/sprint.js resolveDeps() calls (each dep carries .since ms)
 *   G.parseNotBefore(line)                    { date, time, rest } of a **Not before:** value, or null
 *   G.releases(root)                          Map "<inbox>\n<heading>" -> the owner's Start now row (company/state/gate-releases.jsonl)
 *   G.release(root, row)                      the console's Start now: one row (by, inbox, heading, why), provenance recorded
 *   G.whenWords(stamp, todayStr)              "09:00 tomorrow" / "2026-11-24 09:00"
 *   G.PARKED(root)                            company/state/parked.json, written by the dispatcher every tick for the console
 * Owner: the tools function.
 */
const fs = require('fs');
const path = require('path');
const SP = require('./sprint');
const B = require('./bounded');
const C = require('./completions');

const PARKED = root => path.join(root, 'company', 'state', 'parked.json');
const RELEASES = root => path.join(root, 'company', 'state', 'gate-releases.jsonl');

function parseNotBefore(line) {
  const m = String(line || '').match(/^\s*(\d{4}-\d{2}-\d{2})(?:[ T]([01]\d:[0-5]\d|2[0-3]:[0-5]\d))?\b(.*)$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1].slice(0, 4), +m[1].slice(5, 7) - 1, +m[1].slice(8, 10)));
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== m[1]) return null;   // an impossible date never rolls over
  return { date: m[1], time: m[2] || '00:00', rest: m[3] || '' };
}
// "YYYY-MM-DD HH:MM" (company local) -> a comparable ms number (UTC arithmetic on the local wall clock)
function stampMs(s) { const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : NaN; }
function whenWords(stamp, todayStr) {
  const [d, t] = String(stamp).split(' ');
  const tom = new Date(stampMs(todayStr) + 86400e3).toISOString().slice(0, 10);
  return d === todayStr ? t + ' today' : d === tom ? t + ' tomorrow' : d + ' ' + t;
}
// a heading's own stamp ("2026-11-17 22:24 from …"), in company local ms terms
function headingStamp(h) { const m = String(h || '').match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/); return m ? m[1] + ' ' + (m[2] || '00:00') : null; }

function lookups(o) {
  const root = o.root, crew = o.crew || {}, quests = o.quests || [];
  const texts = new Map();
  const read = f => { if (!texts.has(f)) { let t = null; try { t = fs.readFileSync(f, 'utf8'); } catch (_) {} texts.set(f, t); } return texts.get(f); };
  const dir = path.join(root, 'company', 'work', 'handoffs');
  const matches = (it, ref) => { const r = String(ref).toLowerCase().replace(/^#+\s*/, ''); return (it.id && it.id.toLowerCase() === r) || it.heading.toLowerCase().includes(r); };
  function handoffState(inbox, ref, me) {
    const self = me || o.self || {};
    if (!ref || !/^to-[\w.-]+\.md$/.test(inbox)) return null;
    const live = read(path.join(dir, inbox));
    const found = [];
    if (live != null) for (const it of SP.parseItems(live)) if (!(inbox === self.inbox && it.heading === self.heading) && it.status && matches(it, ref)) found.push(it);
    if (found.some(i => i.open)) return 'waiting';
    if (found.length) return 'met';
    const arch = read(path.join(dir, 'archive', inbox));
    if (arch != null && SP.parseItems(arch).some(it => it.status && matches(it, ref))) return 'met';   // archived: finished
    return null;
  }
  const seatByName = name => {
    const n = String(name || '').toLowerCase().trim();
    return Object.keys(crew).find(k => k.toLowerCase() === n) || Object.keys(crew).find(k => { const f = String((crew[k] || {}).name || '').toLowerCase(); return f === n || f.split(/\s+/)[0] === n; }) || null;
  };
  let comps = null, run = null, reg = null;
  const completions = () => comps || (comps = C.recent(root, 300));
  const runningJobs = () => run || (run = C.running(root));
  const registry = () => reg || (reg = ((JSON.parse((() => { try { return fs.readFileSync(path.join(root, 'company', 'state', 'services.json'), 'utf8'); } catch (_) { return '{}'; } })()) || {}).services) || {});
  const after = (iso, since) => Date.parse(iso || '') >= (Number(since) || 0);
  return {
    seatOf: seatByName,
    handoff: d => handoffState(d.inbox, d.ref, d.self),
    seat: d => { const id = seatByName(d.name); const inbox = id && crew[id] && crew[id].inbox; d.seatId = id; return inbox ? handoffState(inbox, d.ref, d.self) : null; },
    quest: d => {
      const q = quests.find(x => x && x.id === d.qid); if (!q) return null;
      if (q.status && q.status !== 'open') return 'met';
      if (!d.step) return 'waiting';
      const s = (q.steps || []).find(x => [x.key, x.stepKey, x.id].includes(d.step)) || (q.steps || []).find(x => String(x.label || '').toLowerCase().includes(d.step.toLowerCase()));
      return s ? (s.done ? 'met' : 'waiting') : null;
    },
    file: d => {
      const p = path.resolve(root, d.path); if (!p.startsWith(path.resolve(root) + path.sep)) return null;
      let st = null; try { st = fs.statSync(p); } catch (_) { return 'waiting'; }
      return !d.changed || st.mtimeMs >= (Number(d.since) || 0) ? 'met' : 'waiting';
    },
    service: d => {
      const rows = completions().filter(r => r.service === d.name);
      if (rows.some(r => r.status === 'ok' && after(r.endedAt, d.since))) return 'met';
      const e = registry()[d.name];
      if (e && e.unit && typeof o.serviceLastOk === 'function') { const t = o.serviceLastOk(e); if (t && t >= (Number(d.since) || 0)) return 'met'; }
      return e || rows.length ? 'waiting' : null;
    },
    job: d => {
      if (completions().some(r => r.id === d.id || r.job === d.id)) return 'met';
      return runningJobs().some(r => r.id === d.id || r.job === d.id) ? 'waiting' : null;
    },
  };
}
function releases(root) {
  const out = new Map();
  for (const l of B.tailLines(RELEASES(root), 300, { maxBytes: 512 * 1024 })) { try { const r = JSON.parse(l); if (r && r.inbox && r.heading) out.set(r.inbox + '\n' + r.heading, r); } catch (_) {} }
  return out;
}
function release(root, row) {
  const f = RELEASES(root);
  const r = { id: 'rel-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 5), at: new Date().toISOString(), by: String(row.by || 'owner').slice(0, 80),
    inbox: String(row.inbox), heading: String(row.heading).slice(0, 300), why: String(row.why || 'Start now').slice(0, 200) };
  if (!/^to-[\w.-]+\.md$/.test(r.inbox)) throw new Error('inbox must be a to-<name>.md file');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const line = JSON.stringify(r) + '\n'; fs.appendFileSync(f, line);
  try { require('../provenance.js').appended(f, line, String(row.writer || 'console (owner Start now)')); } catch (_) {}
  return r;
}
module.exports = { lookups, parseNotBefore, stampMs, whenWords, headingStamp, releases, release, PARKED, RELEASES };
