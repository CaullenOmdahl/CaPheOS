#!/usr/bin/env node
'use strict';
/* lib/owner-rulings.js — the owner's standing rules about what they want to be asked ("the crew decides money for
 * tools under $20", "never ask me about model trials"). A ruling saves the owner the same question again and again.
 *
 * File: company/state/owner-rulings.json
 *   { rulings: [{ id, at, by: 'owner', text (the owner's own words), scope: { categories?: [...], topics?: [...] },
 *                 effect: 'crew-decides' | 'never-ask' | 'ask' }] }
 *   crew-decides  the crew decides it and nobody asks the owner (the owner hears of it in the daily digest at most)
 *   never-ask     nobody asks the owner; the default answer (no) stands, so the crew does not do it
 *   ask           always ask the owner, even where self-governance would let the crew decide
 * The four fixed owner gates (access, ownership, commitment, spend beyond the cap) always reach the owner: a ruling
 * never covers them (match() skips them, add() refuses a ruling scoped to one).
 *
 *   const R = require('./lib/owner-rulings');
 *   R.list(opts)                          -> [ruling]        (an empty list when the file is missing or not trusted)
 *   R.match({category, ref, about, text, fixed}, opts) -> ruling | null   (the newest ruling that covers it)
 *   R.add({by, text, scope, effect}, opts) -> {ok, ruling} | {ok:false, code, error}   (owner only)
 *   R.remove({by, id}, opts)               -> {ok} | {ok:false, code, error}           (owner only)
 *
 *   node company/tools/lib/owner-rulings.js list
 *   node company/tools/lib/owner-rulings.js add --by owner --text "..." --effect crew-decides [--categories a,b] [--topics "x,y"]
 *   node company/tools/lib/owner-rulings.js remove --by owner --id r-...
 *
 * WHO WRITES: only the owner, from the owner's own shell or the console (lib/owner.js refusal; an agent's run is
 * refused with code 3). Each write is atomic and recorded in the provenance log (provenance.js wrote). A reader ignores
 * the file when the newest recorded write of it does not match what is on disk (a hand edit after the owner's write).
 * opts.root: a scratch company (tests); opts.shell: a function standing in for the owner-shell check (tests).
 */
const fs = require('fs');
const path = require('path');
const co = require('./company');

const REL = 'company/state/owner-rulings.json';
const EFFECTS = ['crew-decides', 'never-ask', 'ask'];
const FIXED = ['access', 'ownership', 'commitment', 'commitments', 'spendBeyondCap'];
const rootOf = opts => path.resolve((opts && opts.root) || process.env.GOVERNANCE_ROOT || co.ROOT);
const fileOf = opts => path.join(rootOf(opts), REL);
const sha = t => 'sha256:' + require('crypto').createHash('sha256').update(t).digest('hex');
const low = s => String(s == null ? '' : s).trim().toLowerCase();

/* the newest provenance row for the file, or null (the log keeps 14 days; no row = nothing to compare) */
function lastRecorded(file) {
  try {
    const prov = require('../provenance.js');
    const root = path.resolve(process.env.PROVENANCE_ROOT || co.ROOT);
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (rel.startsWith('..')) return null;
    let last = null; for (const r of prov.readFrom(0, root).rows) if (r.file === rel && r.kind === 'write') last = r;
    return last;
  } catch (_) { return null; }
}
/* the rulings readers may use: the file as the owner's tool wrote it */
function list(opts) {
  const f = fileOf(opts);
  let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch (_) { return []; }
  const rec = lastRecorded(f);
  if (rec && rec.sha256 && rec.sha256 !== sha(txt)) return [];   // changed after the owner's own write: not the owner's
  let d; try { d = JSON.parse(txt); } catch (_) { return []; }
  return (Array.isArray(d && d.rulings) ? d.rulings : []).filter(r => r && r.id && EFFECTS.includes(r.effect) && r.by === 'owner');
}

const STOP = new Set('that this with from have will would could should about there their they them what when your which into only also than then just been were more most some such each very much need want please'.split(' '));
const words = s => new Set(low(s).replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).map(w => w.replace(/(?:ing|ed|es|s)$/, '')).filter(w => w.length >= 3 && !STOP.has(w)));
/* does one topic phrase cover the text? the phrase itself, or every word of it */
function topicHit(topic, text) {
  const t = low(topic); if (!t) return false;
  if (low(text).includes(t)) return true;
  const tw = words(t); if (!tw.size) return false;
  const mine = words(text); for (const w of tw) if (!mine.has(w)) return false;
  return true;
}
/* match(o) -> the newest ruling covering o, or null. A fixed owner gate is never covered. */
function match(o, opts) {
  o = o || {};
  const cat = String(o.category || '');
  if (o.fixed || FIXED.includes(cat) || FIXED.includes(String(o.fixedGate || ''))) return null;
  const text = [o.ref, o.about, o.text, o.message, o.lead].filter(Boolean).join(' ');
  const rs = (opts && Array.isArray(opts.rulings) ? opts.rulings : list(opts)).slice().reverse();
  for (const r of rs) {
    const sc = r.scope || {};
    const cats = Array.isArray(sc.categories) ? sc.categories.map(String) : [];
    const tops = Array.isArray(sc.topics) ? sc.topics.map(String) : [];
    if (!cats.length && !tops.length) continue;   // a ruling with no scope covers nothing
    if (cats.length && !cats.includes(cat)) continue;
    if (tops.length && !tops.some(t => topicHit(t, text))) continue;
    return r;
  }
  return null;
}

function refuse(by, what, opts) {
  if (!require('./owner').isOwnerName(by, { aliases: ['commander'] })) return { ok: false, code: 3, error: 'only the owner makes or removes a standing rule (--by owner)' };
  const why = require('./owner').refusal(by, what, Object.assign({ aliases: ['commander'] }, opts && typeof opts.shell === 'function' ? { shell: opts.shell } : {}));
  return why ? { ok: false, code: 3, error: why } : null;
}
function write(rulings, opts) {
  const f = fileOf(opts);
  const txt = JSON.stringify({ _doc: 'The owner\'s standing rules about what they want to be asked (company/tools/lib/owner-rulings.js). Written only from the owner\'s shell or the console.', rulings }, null, 1) + '\n';
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp-' + process.pid; fs.writeFileSync(tmp, txt); fs.renameSync(tmp, f);
  try { require('../provenance.js').wrote(f, txt, 'owner-rulings'); } catch (_) {}
}
/* add({by, text, scope, effect}) -> {ok, ruling} */
function add(o, opts) {
  o = o || {};
  const no = refuse(o.by, 'a standing rule', opts); if (no) return no;
  const text = String(o.text || '').replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, code: 2, error: 'say the rule in your own words (--text)' };
  if (!EFFECTS.includes(o.effect)) return { ok: false, code: 2, error: 'effect is one of ' + EFFECTS.join(', ') };
  const sc = o.scope || {};
  const categories = [].concat(sc.categories || []).map(s => String(s).trim()).filter(Boolean);
  const topics = [].concat(sc.topics || []).map(s => String(s).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 20);
  if (!categories.length && !topics.length) return { ok: false, code: 2, error: 'say what the rule covers: categories or topics' };
  const fixed = categories.filter(c => FIXED.includes(c));
  if (fixed.length && o.effect !== 'ask') return { ok: false, code: 2, error: fixed.join(', ') + ' is a fixed owner gate: it always comes to you, a standing rule cannot change that' };
  const rulings = list(opts);
  const ruling = { id: 'r-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), at: new Date().toISOString(), by: 'owner', text: text.slice(0, 500),
    scope: Object.assign({}, categories.length ? { categories } : {}, topics.length ? { topics } : {}), effect: o.effect };
  if (o.from) ruling.from = String(o.from).slice(0, 80);   // e.g. the card it was made from
  rulings.push(ruling); write(rulings, opts);
  return { ok: true, ruling };
}
function remove(o, opts) {
  o = o || {};
  const no = refuse(o.by, 'removing a standing rule', opts); if (no) return no;
  const rulings = list(opts); const left = rulings.filter(r => r.id !== o.id);
  if (left.length === rulings.length) return { ok: false, code: 2, error: 'no standing rule ' + o.id };
  write(left, opts);
  return { ok: true, removed: o.id };
}

module.exports = { list, match, add, remove, EFFECTS, REL, topicHit };

if (require.main === module) {
  const a = process.argv.slice(2); const cmd = a[0];
  const flag = k => { const i = a.indexOf('--' + k); return i >= 0 && a[i + 1] !== undefined && !a[i + 1].startsWith('--') ? a[i + 1] : null; };
  const csv = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
  const done = r => { console.log(JSON.stringify(r, null, 1)); process.exit(r.ok === false ? (r.code || 2) : 0); };
  if (cmd === 'list') done({ ok: true, rulings: list() });
  if (cmd === 'add') done(add({ by: flag('by'), text: flag('text'), effect: flag('effect'), scope: { categories: csv(flag('categories')), topics: csv(flag('topics')) } }));
  if (cmd === 'remove') done(remove({ by: flag('by'), id: flag('id') }));
  done({ ok: false, code: 2, error: 'commands: list | add --by owner --text ".." --effect crew-decides|never-ask|ask [--categories a,b] [--topics "x,y"] | remove --by owner --id <id>' });
}
