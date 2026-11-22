#!/usr/bin/env node
/* handoff-archive.js — move finished handoffs out of the inboxes agents re-read every run.
 *
 *   node company/tools/handoff-archive.js [--dry-run] [--hours 3] [--keep 3]
 *
 * Every inbox company/work/handoffs/to-<name>.md is read in full at the start of each loop, so finished threads cost
 * every later run (a busy CEO inbox reaches well over 100 KB of finished items in a day). A section whose **Status:** line
 * starts with DONE, whose newest date (heading or **Resolved** line) is more than --hours (default 3) old, and which is not one of
 * the last --keep sections, is MOVED (never deleted) to company/work/handoffs/archive/to-<name>.md. OPEN sections never
 * move. The dispatcher runs this every tick.
 * Heading and Resolved stamps carry no zone; they are read as company local time (company.json timezone, co.TZ).
 * Safety: the archive is appended first; the inbox is rewritten only if it is byte-identical to what was read, through a
 * temp file and a rename, so an agent's write in between makes this tick skip that inbox instead of losing the write.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const co = require('./lib/company');
const DIR = co.p('company', 'work', 'handoffs');
const ARCH = path.join(DIR, 'archive');
const POINTER = '_Finished handoffs more than 3 hours old are moved to `archive/<this file name>` by the dispatcher; look there for older threads._';

const { localToEpoch } = require('./lib/core-loop');
function newestStamp(sec) {
  const lines = sec.split('\n');
  const scan = [lines[0]].concat(lines.filter(l => /^\*\*Resolved\b/.test(l)));
  let best = 0;
  for (const l of scan) {
    for (const m of l.matchAll(/(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}))?/g)) {
      const t = localToEpoch(m[1], m[2] ? m[2] + ':' + m[3] : '00:00');
      if (Number.isFinite(t) && t > best) best = t;
    }
  }
  return best;
}

function archiveInbox(file, { hours = 3, keep = 3, dry = false, now = Date.now() } = {}) {
  const p = path.join(DIR, file);
  const txt = fs.readFileSync(p, 'utf8');
  const parts = txt.split(/^(?=## )/m);
  const head = parts[0].startsWith('## ') ? '' : parts.shift();
  const big = Buffer.byteLength(txt) > 64 * 1024;
  const effHours = big ? Math.min(hours, 0.5) : hours;
  const effKeep = big ? Math.min(keep, 1) : keep;
  const moved = [], kept = [];
  parts.forEach((sec, i) => {
    const done = /^\*\*Status:\*\*\s*DONE/m.test(sec);
    const t = newestStamp(sec);
    const old = t > 0 && now - t > effHours * 3600e3;
    if (done && old && i < parts.length - effKeep) moved.push(sec); else kept.push(sec);
  });
  if (!moved.length) return 0;
  if (dry) return moved.length;
  const name = file.replace(/^to-|\.md$/g, '');
  let header = head || ('# Handoffs to ' + name.charAt(0).toUpperCase() + name.slice(1) + '\n\n');
  if (!header.includes('archive/')) header = header.replace(/\s*$/, '\n\n') + POINTER + '\n\n';
  const next = header + kept.join('');
  fs.mkdirSync(ARCH, { recursive: true });
  const ap = path.join(ARCH, file);
  const body = moved.map(s => s.replace(/\s*$/, '\n\n')).join('');
  if (fs.readFileSync(p, 'utf8') !== txt) return -1;          // someone wrote meanwhile: try next tick
  fs.appendFileSync(ap, (fs.existsSync(ap) ? '' : '# Archived handoffs to ' + name + '\n\nMoved here from `../' + file + '` by `company/tools/handoff-archive.js`.\n\n') + body);
  const tmp = p + '.archive-tmp';
  fs.writeFileSync(tmp, next);
  if (fs.readFileSync(p, 'utf8') !== txt) { fs.unlinkSync(tmp); return -1; }
  fs.renameSync(tmp, p);
  return moved.length;
}

function run({ dry = false, log = console.log, hours = 3, keep = 3 } = {}) {
  const out = [];
  if (!fs.existsSync(DIR)) return out;
  for (const f of fs.readdirSync(DIR).filter(f => /^to-[a-z0-9-]+\.md$/.test(f))) {
    try {
      const n = archiveInbox(f, { hours, keep, dry });
      if (n > 0) out.push(f + ' ' + n);
      if (n < 0) out.push(f + ' skipped (changed while archiving)');
    } catch (e) { out.push(f + ' ERROR ' + e.message); }
  }
  if (out.length) log((dry ? 'would archive' : 'archived') + ' finished handoffs: ' + out.join(', '));
  return out;
}

module.exports = { run, archiveInbox, newestStamp, localToEpoch };
if (require.main === module) {
  const a = process.argv.slice(2);
  const num = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? Number(a[i + 1]) : d; };
  run({ dry: a.includes('--dry-run'), hours: num('hours', 3), keep: num('keep', 3) });
}
