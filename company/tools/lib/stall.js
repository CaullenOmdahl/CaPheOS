'use strict';
/* lib/stall.js — is a seat stuck on its handoffs? Judged on PROGRESS EVIDENCE, not on the set of OPEN headings
 * (dispatch.js; owner ruling "work as soon as possible": a future date never exempts a seat from the check).
 *
 * A seat is stalled only when, across STALL_AFTER of its wakes, NONE of these happened:
 *   - the text of one of its OPEN blocks changed (a Progress or Status line; the block's body without its heading and
 *     its date lines, so re-dating a block is never progress);
 *   - one of its blocks was closed, or it wrote a block to someone else's inbox;
 *   - a run of the seat wrote a file under company/work or a repo, produced an artifact or ticked a quest step
 *     (the station's run record: completionEvidence.effects, artifacts);
 *   - new work arrived (a heading it has not seen before: a new item is a new budget, not progress to hide behind).
 * The STALLED line names the block: the oldest overdue, else an undated, else the soonest due block that did not move.
 * A seat that IS moving but whose due block has not changed in STALL_AFTER*2 wakes gets a softer note to its manager.
 */
const crypto = require('crypto');

const DATE_LINE = /^\*\*(Deadline|Due|Not before|Lane)(:\*\*|\*\*:)[^\n]*$/gim;
const h16 = s => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
// a block's body as progress sees it: no heading, no date lines, no trailing space
function bodySig(section) { return h16(String(section || '').split('\n').slice(1).join('\n').replace(DATE_LINE, '').replace(/\s+$/g, '')); }

const WRITES = /^(fs\.(write|edit|append|patch)|notebook\.write)$/;
// what a seat's runs since a moment did that counts as progress (names of the evidence, never contents)
function runEvidence(rows, seat, sinceMs) {
  const out = [];
  for (const r of rows || []) {
    if (!r || r.agentId !== seat || !(Number(r.endedAt || r.ts) > sinceMs)) continue;
    const effects = (r.completionEvidence && Array.isArray(r.completionEvidence.effects)) ? r.completionEvidence.effects : [];
    for (const e of effects) {
      const t = String(e.target || '');
      if (WRITES.test(String(e.tool || '')) && (!t || /^(company\/work\/|company\/repos\/|repos\/)/.test(t) || !t.startsWith('company/'))) out.push('wrote ' + (t || 'a file'));
      else if (e.tool === 'quest.update') out.push('quest ' + (t || 'step'));
    }
    if (Array.isArray(r.artifacts) && r.artifacts.length) out.push('artifact');
  }
  return [...new Set(out)];
}

/* judge(prev, cur) -> { moved, why[], blocks } ; prev/cur: { sigs: {heading: sig}, closed, sent } plus cur.evidence[] */
function judge(prev, cur) {
  const why = [];
  const ps = (prev && prev.sigs) || {};
  for (const [h, s] of Object.entries(cur.sigs || {})) {
    if (!(h in ps)) why.push('new item "' + h.slice(0, 60) + '"');
    else if (ps[h] !== s) why.push('"' + h.slice(0, 60) + '" changed');
  }
  if (prev && Number(cur.closed) > Number(prev.closed || 0)) why.push('closed a block');
  if (prev && Number(cur.sent) > Number(prev.sent || 0)) why.push('wrote a block to someone');
  for (const e of cur.evidence || []) why.push(e);
  return { moved: why.length > 0, why };
}

// the block to name: the oldest overdue, else an undated one, else the soonest due — among blocks that did not move
function stuckBlock(open, due, overdue, movedSet) {
  const still = (open || []).filter(h => !(movedSet && movedSet.has(h)));
  const pool = still.length ? still : (open || []);
  const od = pool.filter(h => (overdue || []).includes(h)).sort((a, b) => String(due.get(a)).localeCompare(String(due.get(b))));
  if (od.length) return od[0];
  const undated = pool.filter(h => !due.has(h)); if (undated.length) return undated[0];
  return pool.slice().sort((a, b) => String(due.get(a)).localeCompare(String(due.get(b))))[0] || null;
}

module.exports = { bodySig, runEvidence, judge, stuckBlock };
