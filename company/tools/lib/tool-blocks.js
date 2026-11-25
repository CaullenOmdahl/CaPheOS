'use strict';
/* lib/tool-blocks.js — which handoff blocks the company's own tools wrote (the dispatcher and the tools it runs), told
 * apart by provenance, never by the heading's words. Anyone can type "## … from Dispatcher — …" into an inbox; only a
 * block a tool appended through append() (or recorded with record()) is the tool's.
 *
 *   const TB = require('./lib/tool-blocks');
 *   TB.append(file, block, o?)        fs.appendFileSync + record(): the way a tool writes a "from Dispatcher" block
 *   TB.record(file, block, o?)        one row per append in company/state/tool-blocks.jsonl ({ at, file: <inbox>, heads:
 *                                     [<heading as parseItems reads it>] }), the row itself recorded with provenance.js, so
 *                                     a hand-written row is never read (lib/recorded.js)
 *   TB.index(root)                    Map inbox -> Map heading -> how many blocks with that heading a tool appended there
 *   TB.picker(root, inbox)            (items in file order) -> Set of the items a tool wrote: each recorded heading counts
 *                                     for one block, the first ones in the file (a copy of a tool's heading is not the tool's)
 * o: { root } (default: the root that holds the inbox file, <root>/company/work/handoffs/<inbox>). Owner: the tools function.
 */
const fs = require('fs');
const path = require('path');

const WRITERS = ['dispatch.js', 'accountable.js', 'approvals.js', 'competence.js', 'routing.js', 'consult.js', 'departments.js', 'settle.js', 'dispatcher-loop.js', 'security-watch.js', 'default-branch-watch.js', 'harness-change.js', 'corrections.js', 'deps.js',
  // the tools that write a notice or the owner's routed message into a seat's inbox (never held as a member's message)
  'owner-addressing.js', 'hire.js', 'models.js', 'pacer.js', 'long-sleep.js', 'onboard.js'];
const ledgerOf = root => path.join(root, 'company', 'state', 'tool-blocks.jsonl');
function rootOfInbox(file) {
  const dir = path.dirname(path.resolve(file));
  // Real company inboxes live at <root>/company/work/handoffs/<inbox>.
  // Only walk three levels up when the parent chain actually matches that layout;
  // otherwise (e.g. a flat temp dir under <company>/.starnet-data/tmp/<run>/),
  // stay inside dir so test fixtures never escape into an ancestor company's ledger.
  if (path.basename(dir) === 'handoffs'
    && path.basename(path.dirname(dir)) === 'work'
    && path.basename(path.dirname(path.dirname(dir))) === 'company') {
    return path.resolve(dir, '..', '..', '..');
  }
  return dir;
}
// the provenance writer name: the running tool when it is one of ours, else the dispatcher (a tool's library in its process)
function writerName() { const m = require.main && require.main.filename; const b = m ? path.basename(m) : ''; return WRITERS.includes(b) ? b : 'dispatch.js'; }
const headsOf = block => String(block || '').split('\n').filter(l => l.startsWith('## ')).map(l => l.slice(3).trim()).filter(Boolean);

function record(file, block, o) {
  try {
    const heads = headsOf(block); if (!heads.length) return false;
    const root = path.resolve((o && o.root) || rootOfInbox(file)), f = ledgerOf(root);
    const line = JSON.stringify({ at: new Date().toISOString(), file: path.basename(file), heads }) + '\n';
    fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, line);
    try { require('../provenance.js').appended(f, line, writerName(), { root }); } catch (_) {}
    return true;
  } catch (_) { return false; }
}
function append(file, block, o) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, block); record(file, block, o); }

const CACHE = new Map();
function index(root) {
  root = path.resolve(root); const f = ledgerOf(root);
  let st = null; try { st = fs.statSync(f); } catch (_) { return new Map(); }
  const c = CACHE.get(f); if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.map;
  let text = ''; try { text = require('./bounded').tailText(f, 8 << 20); } catch (_) { try { text = fs.readFileSync(f, 'utf8'); } catch (_) {} }
  const map = new Map();
  let ls = []; try { ls = require('./recorded').lines(f, WRITERS, { root, text }); } catch (_) { ls = []; }
  for (const l of ls) {
    let r; try { r = JSON.parse(l); } catch (_) { continue; }
    if (!r || typeof r.file !== 'string' || !Array.isArray(r.heads)) continue;
    const m = map.get(r.file) || new Map(); for (const h of r.heads) m.set(String(h), (m.get(String(h)) || 0) + 1); map.set(r.file, m);
  }
  CACHE.set(f, { size: st.size, mtimeMs: st.mtimeMs, map });
  return map;
}
function picker(root, inbox) {
  const counts = index(root).get(String(inbox)) || new Map();
  return items => { const left = new Map(counts), out = new Set(); for (const it of items || []) { const n = left.get(it.heading) || 0; if (n > 0) { left.set(it.heading, n - 1); out.add(it); } } return out; };
}

module.exports = { WRITERS, ledgerOf, record, append, index, picker, headsOf };
