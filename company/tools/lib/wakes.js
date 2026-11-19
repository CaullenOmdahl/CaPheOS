'use strict';
/* lib/wakes.js — which handoff items each run the dispatcher starts is for (docs/TEMPO.md, "Run-to-item links").
 *
 * Measurement only: nothing here decides a wake. Each time dispatch.js starts a run for a seat (HTTP 200) it appends ONE
 * row to company/state/wakes.jsonl:
 *   { at, wakeId, seat, runId (when the station's answer named it), admitId, jobId, door, items: [{file, id, title, due}], why,
 *     route? }   route: the router's decision for the wake (lib/routing.js decide(); only when a routing policy exists)
 * items = the handoff blocks that made the wake due: the seat's OPEN items that were work now (not waiting on anyone, not
 * set aside by Not before), plus a block the dispatcher wrote into the inbox for this wake (a duty, a failed watched job).
 * A wake with no item (a scheduled loop, an owner message, a quest step, a hiring pick) lists none; `why` says what it was.
 *
 * Item id (stable across ticks): the block's own `**Id:**` line when it has one (lib/sprint.js parseItems); else
 * `<inbox file>#<first 6 hex of sha256(heading)>`, the id handoff-status.js already gives a block. Re-wording or re-dating
 * a heading changes a derived id; write an **Id:** line on a block whose heading will change.
 *
 *   const W = require('./lib/wakes');
 *   W.itemId(file, heading, explicitId)       the stable id above
 *   W.newWakeId(now)                           a fresh wakeId (the router assigns trials by it before the run starts)
 *   W.record(row, { file?, dry? })             append one row (file null: write nothing); returns the row
 *   W.rows({ sinceMs, file? })                 the rows since then, read from the end (lib/bounded.js)
 *   W.runIdOf(body)                            the runId a POST /api/cron/run answer names, or null
 *   W.closedItems([{file, text}], { sinceMs, untilMs })  the DONE blocks closed in the window: [{file, id, title, closedAt}]
 *   W.doneItems({ root, sinceMs, untilMs })    the same over the inboxes and their archive (each file read bounded)
 *   W.linkItems(rows, doneItems, { attributed })  each DONE item -> the wakes and runs that worked it, and the linked share
 *   W.report({ hours, now, root })             linkItems over a window: the share of DONE items with a linked run
 *                                              (target TARGET); offline, no model run
 * Retention: wakes.jsonl rolls monthly, 30 days kept (company/defaults/work/ops/retention.json "wakes").
 * Owner: the tools function.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const co = require('./company');

const TARGET = 0.9;
const FILE = o => (o && o.file) || co.p('company', 'state', 'wakes.jsonl');
const clip = (s, n) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').slice(0, n || 200);
let SEQ = 0;
const newWakeId = now => 'wk-' + Number(now).toString(36) + '-' + process.pid.toString(36) + '-' + (SEQ++).toString(36);

function itemId(file, heading, explicit) {
  const x = String(explicit || '').replace(/`/g, '').trim();
  if (x) return x;
  return String(file) + '#' + crypto.createHash('sha256').update(String(heading).trim()).digest('hex').slice(0, 6);
}
function record(row, o) {
  o = o || {};
  const now = Number.isFinite(row && row.at) ? row.at : Date.now();
  const r = { at: now, ts: new Date(now).toISOString(), wakeId: (row && row.wakeId) || newWakeId(now), seat: clip(row && row.seat, 80), runId: row && row.runId ? clip(row.runId, 80) : null,
    door: clip((row && row.door) || 'dispatch', 20), items: ((row && row.items) || []).slice(0, 40).map(i => ({ file: clip(i.file, 120), id: clip(i.id, 160), title: clip(i.title, 160), due: i.due ? clip(i.due, 20) : null })),
    why: clip(row && row.why, 300) };
  if (row && row.admitId) r.admitId = clip(row.admitId, 80);
  if (row && row.jobId) r.jobId = clip(row.jobId, 80);
  if (row && row.route && typeof row.route === 'object') r.route = row.route;   // lib/routing.js decide(): which model, and why (absent without a routing policy)
  // narrow fan-out (lanes.js piece lanes): the split this wake works one piece of, so the ranking's fanoutEvaluation sees it
  if (row && row.split && typeof row.split === 'object') r.split = { item: clip(row.split.item, 160), piece: Number(row.split.piece) || null, lead: clip(row.split.lead, 80), split: row.split.split ? clip(row.split.split, 40) : null };
  if (o.dry || o.file === null) return r;
  const f = FILE(o);
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify(r) + '\n'); } catch (_) { /* measurement never breaks a wake */ }
  return r;
}
function rows(o) {
  o = o || {};
  const since = Number.isFinite(o.sinceMs) ? o.sinceMs : Date.now() - 7 * 86400e3;
  try { return require('./bounded').jsonlWindow(FILE(o), { sinceMs: since, tsOf: r => Number(r.at) || 0 }).rows.filter(r => r && (Number(r.at) || 0) >= since); } catch (_) { return []; }
}
function runIdOf(body) {
  const s = String(body || '');
  try { const j = JSON.parse(s); if (j && j.runId) return String(j.runId); } catch (_) {}
  const m = s.match(/"runId"\s*:\s*"([A-Za-z0-9_.:-]{4,100})"/);
  return m ? m[1] : null;
}

/* the newest date a closed block names (its heading or a Resolved line): when it was closed, company local time
   (the stamp handoff-archive.js reads). A stamp with only a date ("**Resolved 2026-11-18 by …**") closed at some time
   that day, so it counts as the END of that day: read as 00:00 it would cut off every wake later that same day. */
function closeBoundsOf(sec) {
  const { localToEpoch } = require('./core-loop');
  const lines = String(sec).split('\n');
  let at = 0, by = 0;
  for (const l of [lines[0]].concat(lines.filter(x => /^\*\*Resolved\b/.test(x)))) {
    for (const m of l.matchAll(/(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}))?/g)) {
      const t = localToEpoch(m[1], m[2] ? m[2] + ':' + m[3] : '00:00');
      const u = m[2] ? t : localToEpoch(m[1], '23:59') + 59999;
      if (Number.isFinite(t) && t > at) at = t;
      if (Number.isFinite(u) && u > by) by = u;
    }
  }
  return { at: at || null, by: by || null };
}
// the close time used for the report window (a date-only stamp: the start of that day)
function closedAtOf(sec) { return closeBoundsOf(sec).at; }
function closedItems(files, o) {
  o = o || {};
  const since = Number.isFinite(o.sinceMs) ? o.sinceMs : -Infinity, until = Number.isFinite(o.untilMs) ? o.untilMs : Infinity;
  const SP = require('./sprint');
  const out = [], seen = new Set();
  for (const { file, text } of files || []) {
    for (const sec of String(text || '').split(/^## /m).slice(1)) {
      const it = SP.parseItems('## ' + sec)[0];
      if (!it || !it.status || !/^DONE\b/i.test(it.status)) continue;
      const { at: closedAt, by: closedBy } = closeBoundsOf(sec);
      if (!closedAt || closedAt < since || closedAt > until) continue;
      const id = itemId(file, it.heading, it.id);
      if (seen.has(file + '\n' + id)) continue;
      seen.add(file + '\n' + id);
      // resolved: the block was opened and later closed (a **Resolved** line). A block DONE when written (an FYI, a
      // notice, a completion note: "DONE — FYI", "nothing to close") is no finished work unless a wake ever listed it
      out.push({ file, id, title: clip(it.heading, 160), closedAt, closedBy, resolved: /^\*\*Resolved\b/m.test(sec) });
    }
  }
  return out;
}
function doneItems(o) {
  o = o || {};
  const root = o.root || co.ROOT;
  const dir = path.join(root, 'company', 'work', 'handoffs'), arch = path.join(dir, 'archive');
  const B = require('./bounded'); const maxBytes = Number(o.maxBytes) > 0 ? Number(o.maxBytes) : 8 * B.MB;
  const sinceMonth = Number.isFinite(o.sinceMs) ? new Date(o.sinceMs).toISOString().slice(0, 7) : '0000-00';
  const files = [];
  const add = (file, p) => { try { files.push({ file, text: B.tailText(p, maxBytes) }); } catch (_) {} };
  const ls = d => { try { return fs.readdirSync(d); } catch (_) { return []; } };
  for (const f of ls(dir)) if (/^[A-Za-z0-9_.-]+\.md$/.test(f) && f !== 'README.md') add(f, path.join(dir, f));
  for (const f of ls(arch)) {
    if (/\.md$/.test(f)) add(f, path.join(arch, f));
    else for (const m of ls(path.join(arch, f))) if (/^\d{4}-\d{2}\.md$/.test(m) && m.slice(0, 7) >= sinceMonth) add(f + '.md', path.join(arch, f, m));   // a retention roll: archive/<inbox>/<YYYY-MM>.md
  }
  return closedItems(files, o);
}

/* linkItems(rows, doneItems, { attributed?: [{admitId, runId}], slackMs? }) — for each DONE item, the wakes that listed it
   at or before it closed (slackMs, default 10 min, for clocks) and the runs those wakes started. A wake whose row has no
   runId takes the run admit() attribution matched to its admitId. linked = at least one run. */
function linkItems(list, done, o) {
  o = o || {};
  const slack = Number(o.slackMs) >= 0 ? Number(o.slackMs) : 10 * 60e3;
  const runOfAdmit = new Map(); for (const a of o.attributed || []) if (a && a.admitId && a.runId) runOfAdmit.set(a.admitId, a.runId);
  const byItem = new Map();
  for (const r of list || []) for (const i of (r && r.items) || []) { const k = i.file + '\n' + i.id; if (!byItem.has(k)) byItem.set(k, []); byItem.get(k).push(r); }
  const items = [];
  for (const d of done || []) {
    if (d.resolved === false && !byItem.has(d.file + '\n' + d.id)) continue;   // born DONE and never worked: not an item
    // a wake counts when it came before the close: the latest moment the stamp allows (a date-only stamp: the end of that
    // day). With no Resolved line the close time is not known (the heading dates the request), so every listing wake counts
    const bound = d.resolved === false ? null : (d.closedBy || d.closedAt);
    const ws = (byItem.get(d.file + '\n' + d.id) || []).filter(r => !bound || (Number(r.at) || 0) <= bound + slack);
    const runs = [...new Set(ws.map(r => r.runId || (r.admitId && runOfAdmit.get(r.admitId)) || null).filter(Boolean))];
    items.push({ file: d.file, id: d.id, title: d.title, closedAt: d.closedAt || null, wakes: ws.map(r => r.wakeId), runs, linked: runs.length > 0 });
  }
  const linked = items.filter(x => x.linked).length;
  const share = items.length ? linked / items.length : null;
  return { total: items.length, linked, wakeOnly: items.filter(x => !x.linked && x.wakes.length).length, share, target: TARGET, met: share == null ? null : share >= TARGET, items };
}
function report(o) {
  o = o || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const hours = Number(o.hours) > 0 ? Number(o.hours) : 24 * 7;
  const sinceMs = now - hours * 3600e3;
  const done = o.done || doneItems({ root: o.root, sinceMs, untilMs: now });
  const list = o.rows || rows({ sinceMs: sinceMs - 7 * 86400e3, file: o.file });   // a wake can come days before the close
  let attributed = o.attributed;
  if (!attributed) { try { const A = require('./admit'); const runs = require('./bounded').jsonlWindow(co.p('.starnet-data', 'workspaces', 'runs.jsonl'), { sinceMs: sinceMs - 7 * 86400e3 }).rows; attributed = A.attribute(runs, A.rows({ sinceMs: sinceMs - 7 * 86400e3 - 3600e3 })); } catch (_) { attributed = []; } }
  return Object.assign({ sinceMs, untilMs: now, hours }, linkItems(list, done, { attributed }));
}

module.exports = { TARGET, FILE, newWakeId, itemId, record, rows, runIdOf, closedAtOf, closeBoundsOf, closedItems, doneItems, linkItems, report };
