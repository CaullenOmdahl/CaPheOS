#!/usr/bin/env node
/* decision.js — the one way an agent writes company/work/decisions.md: add a decision, amend one, withdraw one.
 *
 *   node company/tools/decision.js add --by <Name> --text "<the decision>" [--why "<reason>"] [--own-error]
 *        --own-error: the entry is a table row with "<Name> (own error)" in its Owner column (competence.js counts it as
 *        owning your error, docs: company/work/people/COMPETENCE.md); only you can write your own
 *   node company/tools/decision.js amend <id-or-stamp> --by <Name> --why "<what changes and why>" [--text "<the decision as it now stands>"]
 *   node company/tools/decision.js withdraw <id-or-stamp> --by <Name> --why "<why it no longer stands>"
 *   node company/tools/decision.js list [--limit 20] [--json]      newest first, with each entry's id
 *   node company/tools/decision.js show <id-or-stamp>               one entry (live file or the archive)
 *   node company/tools/decision.js selftest
 *
 * decisions.md is GROW-ONLY and newest first (locked-watch.js checks that every earlier line is still there, in order;
 * retention.js rolls old entries into company/work/archive/decisions/). An entry is never edited or removed in place,
 * not even your own, not even minutes later: that is a rewrite of the record, and the watcher flags it. To correct one,
 * `amend` it; to take one back, `withdraw` it. Both write a NEW entry at the top that names the earlier one
 * ("**Amends 2026-11-17 15:30 [d-1b2c3d]** ..."), and the earlier entry stays exactly as it was written.
 *
 * Ids: every entry this tool writes carries `[d-xxxxxx]`. An older entry without one has a stable derived id (the first
 * 6 hex of sha256 of its first line), shown by `list`; since lines never change, the id never changes. <id-or-stamp> is
 * that id, or the entry's stamp ("2026-11-17 15:30", or "15:30" for today); a stamp that matches several entries is
 * narrowed to the --by person's own, and otherwise refused with the ids to choose from. Amend or withdraw someone
 * else's entry only as the CEO or the owner.
 * Provenance: each write is one insert (temp file + rename, under locked-watch's lock, so no tick and no retention roll
 * sees it half done), recorded with provenance.inserted(): the watcher takes the insert back out and checks the rest is
 * history, also when a retention roll happened in the same tick. Text is one line; it may not forge a competence anchor
 * or a retention pointer (those words are rewritten).
 * Exit: 0 ok, 1 selftest failure, 2 usage or refused. Owner of this tool: the tools function (co.seatFor('tools')).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const co = require('./lib/company');

const S = { root: () => co.ROOT, now: () => Date.now() };   // seams for the selftest
const FILE = () => path.join(S.root(), 'company', 'work', 'decisions.md');
const ARCHIVE = () => path.join(S.root(), 'company', 'work', 'archive', 'decisions');
const HEADER = '# Decisions\n\nNewest first. Who decided, what, why.\n\n';
const TAG = 'company/tools/decision.js';
const sha6 = t => crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 6);
const ID_RE = /\[(d-[0-9a-f]{6})\]/;
const ENTRY_RE = /^(?:[-*] |\| )(?:\*\*)?(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/;   // retention.js DATE_ENTRY, plus the time
const SECTION_RE = /^## .*?(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/;

/* ---------------- reading ---------------- */
// entries(text) -> [{ line (0-based), first, stamp, id, derived, author, preview }]
function entries(text) {
  const out = [];
  String(text || '').split('\n').forEach((l, i) => {
    const m = ENTRY_RE.exec(l) || SECTION_RE.exec(l); if (!m) return;
    const stamp = m[1] + (m[2] ? ' ' + m[2] : '');
    const exp = ID_RE.exec(l);
    const cells = l.startsWith('|') ? l.split('|').map(x => x.trim()) : null;   // | stamp | what | owner | ... |
    const after = cells ? String(cells[2] || '') : l.slice(l.indexOf(stamp) + stamp.length).replace(/^\s*/, '');
    const author = cells ? String(cells[3] || '').replace(/\(.*$/, '').trim()
      : (/^([A-Z][\w.'-]*(?: [A-Z][\w.'-]*){0,2})/.exec(after.replace(/^\*\*/, '')) || [])[1] || '';
    out.push({ line: i, first: l, stamp, id: exp ? exp[1] : 'd-' + sha6(l.trim()), derived: !exp, author,
      preview: after.replace(ID_RE, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().slice(0, 90) });
  });
  return out;
}
function archiveTexts() {
  let fl = []; try { fl = fs.readdirSync(ARCHIVE()).filter(f => /^\d{4}-\d{2}\.md$/.test(f)).sort().reverse(); } catch (_) {}
  return fl.map(f => ({ file: path.join('company', 'work', 'archive', 'decisions', f), text: fs.readFileSync(path.join(ARCHIVE(), f), 'utf8') }));
}
const today = () => co.localParts(new Date(S.now())).date;
// resolve a ref against the live file, then the archive. -> { entry, where } | { error }
function resolve(ref, by) {
  const r = String(ref || '').trim();
  if (!r) return { error: 'name the entry: its id (d-xxxxxx, see `decision.js list`) or its stamp ("2026-11-17 15:30" or "15:30")' };
  const live = entries(readLive());
  const pools = [{ where: 'company/work/decisions.md', list: live }].concat(archiveTexts().map(a => ({ where: a.file, list: entries(a.text) })));
  if (/^d-[0-9a-f]{6}$/.test(r)) {
    for (const p of pools) { const e = p.list.find(x => x.id === r); if (e) return { entry: e, where: p.where }; }
    return { error: 'no entry with id ' + r + ' in decisions.md or its archive' };
  }
  const m = /^(?:(\d{4}-\d{2}-\d{2})[ T])?(\d{2}:\d{2})$/.exec(r) || /^(\d{4}-\d{2}-\d{2})$/.exec(r);
  if (!m) return { error: '"' + r + '" is neither an id (d-xxxxxx) nor a stamp ("2026-11-17 15:30" or "15:30")' };
  const want = m[2] ? (m[1] || today()) + ' ' + m[2] : m[1];
  for (const p of pools) {
    let hits = p.list.filter(e => e.stamp === want || (!m[2] && e.stamp.startsWith(want)));
    if (!hits.length) continue;
    if (hits.length > 1 && by) { const own = hits.filter(e => sameName(e.author, by)); if (own.length) hits = own; }
    if (hits.length > 1) return { error: hits.length + ' entries at ' + want + ': ' + hits.map(e => e.id + ' (' + e.preview.slice(0, 60) + ')').join('; ') + '. Name one by its id.' };
    return { entry: hits[0], where: p.where };
  }
  return { error: 'no entry at ' + want + ' in decisions.md or its archive' + (m[1] ? '' : ' (a bare time means today, ' + today() + ')') };
}
const sameName = (a, b) => { const x = String(a || '').toLowerCase().trim(), y = String(b || '').toLowerCase().trim(); return !!x && !!y && (x === y || x.split(' ')[0] === y.split(' ')[0]); };
function readLive() { try { return fs.readFileSync(FILE(), 'utf8'); } catch (_) { return ''; } }

/* ---------------- writing ---------------- */
// one line; no forged competence anchor, own-error row or retention pointer can come in through the text
function clean(t, max) {
  return String(t || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
    .replace(/Competence ledger anchor/gi, 'competence anchor').replace(/moved there by company\/tools\/retention\.js/gi, 'moved by retention')
    .replace(/\(own error\)/gi, '(own-error)').slice(0, max || 1500);
}
function newId(text) { const have = new Set(entries(text).map(e => e.id)); let id; let n = 0; do { id = 'd-' + sha6(S.now() + ':' + process.pid + ':' + (n++) + ':' + crypto.randomBytes(4).toString('hex')); } while (have.has(id)); return id; }
function stampNow() { const lp = co.localParts(new Date(S.now())); return lp.date + ' ' + lp.time; }
// where a new entry goes: before the first entry (after the header and the retention pointer), else at the end
function insertAt(text) {
  const lines = text.split('\n'); let off = 0;
  for (const l of lines) { if (ENTRY_RE.test(l) || SECTION_RE.test(l)) return off; off += Buffer.byteLength(l) + 1; }
  return null;
}
function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
// insert `line` at the top, atomically, under the watcher's lock; record it. -> { ok, id } | { error }
function write(line) {
  const file = FILE(); fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, HEADER);
  const LW = require('./locked-watch.js');
  for (let attempt = 0; attempt < 20; attempt++) {
    const r = LW.withWatchLock({ root: S.root(), log: () => {} }, () => {
      const before = fs.readFileSync(file); const text = before.toString('utf8');
      let off = insertAt(text); let chunk = line + '\n';
      if (off === null) { off = before.length; if (before.length && before[before.length - 1] !== 10) chunk = '\n' + chunk; }
      const ob = off;   // a byte offset: insertAt counts bytes
      const after = Buffer.concat([before.subarray(0, ob), Buffer.from(chunk), before.subarray(ob)]);
      const mode = fs.statSync(file).mode & 0o7777; const tmp = file + '.decision-tmp';
      fs.writeFileSync(tmp, after); fs.chmodSync(tmp, mode);
      const now = fs.readFileSync(file);
      if (!now.equals(before)) { try { fs.unlinkSync(tmp); } catch (_) {} return { retry: true }; }   // someone appended meanwhile
      fs.renameSync(tmp, file);
      require('./provenance.js').inserted(file, { before, after, offset: ob }, 'decision.js');
      return { ok: true };
    });
    if (r && r.ok) return r;
    sleepMs(r && r.busy ? 500 : 50);
  }
  return { error: 'decisions.md is busy (the locked-file watch or a retention roll holds it); try again in a minute' };
}
function who(by) {
  const name = String(by || '').trim();
  if (!name || name === 'true') return { error: '--by <Name> is required (who decides)' };
  const crew = Object.entries(co.crew()); const owner = (co.config.owner && co.config.owner.name) || 'Owner';
  const seat = crew.find(([, c]) => c && sameName(c.name, name));
  if (!seat && !sameName(owner, name) && name.toLowerCase() !== 'owner') return { error: '--by "' + name + '" is not on the crew (company/tools/loops.json) and is not the owner' };
  const isOwner = !seat; const isCeo = !!seat && seat[0] === co.ceo();
  return { name: seat ? seat[1].name : (sameName(owner, name) ? owner : name), isOwner, isCeo };
}
function add(o) {
  const w = who(o.by); if (w.error) return w;
  const text = clean(o.text && o.text !== true ? o.text : o.why); if (!text || o.why === true) return { error: 'add needs --text "<the decision>" (and --why "<reason>", or the reason inside the text)' };
  const why = o.text && o.text !== true && o.why && o.why !== true ? clean(o.why, 600) : '';
  const id = newId(readLive());
  const line = o['own-error']
    ? '| ' + stampNow() + ' | ' + (text + (why ? ' Why: ' + why : '')).replace(/\|/g, '/') + ' [' + id + '] | ' + w.name + ' (own error) | ' + TAG + ' |'
    : '- ' + stampNow() + ' ' + w.name + ' [' + id + '] ' + text + (why ? ' Why: ' + why : '') + ' (' + TAG + ')';
  const r = write(line); return r.ok ? { ok: true, id, line } : r;
}
function change(kind, ref, o) {
  const w = who(o.by); if (w.error) return w;
  const why = clean(o.why, 1000); if (!why || o.why === true) return { error: kind + ' needs --why "..." (what changes and why)' };
  const r = resolve(ref, w.name); if (r.error) return r;
  const e = r.entry;
  if (e.author && !sameName(e.author, w.name) && !w.isCeo && !w.isOwner) return { error: e.id + ' (' + e.stamp + ') is ' + e.author + '\'s entry: only its author, the CEO or the owner can ' + kind + ' it. Add your own entry instead (decision.js add).' };
  const text = kind === 'amend' && o.text && o.text !== true ? clean(o.text) : '';
  const id = newId(readLive());
  const head = kind === 'amend' ? 'Amends' : 'Withdraws';
  const line = '- ' + stampNow() + ' ' + w.name + ' [' + id + '] **' + head + ' ' + e.stamp + ' [' + e.id + ']** ("' + clean(e.preview, 80).replace(/"/g, "'") + '"' + (r.where !== 'company/work/decisions.md' ? ', in ' + r.where : '') + '): '
    + (kind === 'amend' ? (text ? text + ' Why: ' + why : why) : why + (/[.!?]$/.test(why) ? '' : '.') + ' The earlier entry stands as written; this one takes it back.') + ' (' + TAG + ')';
  const x = write(line); return x.ok ? { ok: true, id, refers: e.id, line } : x;
}
function list(o) {
  const n = Number(o.limit) > 0 ? Number(o.limit) : 20;
  return entries(readLive()).slice(0, n).map(e => ({ id: e.id, stamp: e.stamp, author: e.author, derived: e.derived || undefined, preview: e.preview }));
}

/* ---------------- CLI ---------------- */
function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2); const nx = argv[i + 1];
    if (k === 'json' || k === 'own-error') { o[k] = true; continue; }
    if (nx !== undefined && !nx.startsWith('--')) { o[k] = nx; i++; } else o[k] = true;
  }
  return o;
}
function main(argv) {
  const o = parse(argv); const cmd = o._[0];
  const outp = r => { if (r && r.error) { console.error('decision.js: ' + r.error); return 2; } console.log(o.json ? JSON.stringify(r, null, 1) : (r.line || JSON.stringify(r))); return 0; };
  if (cmd === 'add') return outp(add(o));
  if (cmd === 'amend' || cmd === 'withdraw') return outp(change(cmd, o._[1], o));
  if (cmd === 'list') { const l = list(o); if (o.json) console.log(JSON.stringify(l, null, 1)); else for (const e of l) console.log(e.id + '  ' + e.stamp.padEnd(16) + ' ' + (e.author || '?').padEnd(14) + ' ' + e.preview); return 0; }
  if (cmd === 'show') { const r = resolve(o._[1], null); if (r.error) return outp(r); console.log(JSON.stringify({ id: r.entry.id, stamp: r.entry.stamp, author: r.entry.author, where: r.where, line: r.entry.first }, null, 1)); return 0; }
  console.error('usage: decision.js add|amend <id-or-stamp>|withdraw <id-or-stamp> --by <Name> --why "..." [--text "..."] | list | show <id-or-stamp> | selftest'); return 2;
}

/* ---------------- selftest ---------------- */
async function selftest() {
  const assert = require('assert'); const os = require('os');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-selftest-')); const H = path.join(T, 'home');
  const prevRoot = S.root; S.root = () => T; process.env.PROVENANCE_ROOT = T;
  const P = require('./provenance.js'); P.pinUnderStation(false);
  const LW = require('./locked-watch.js'); const RT = require('./retention.js'); const C = require('./competence.js');
  const Wf = (rel, v) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, v); return f; };
  const R = rel => fs.readFileSync(path.join(T, rel), 'utf8');
  const DEC = 'company/work/decisions.md';
  // crew: co.crew() reads the LIVE loops.json; point it at the fixture's for the duration
  const crewFix = { founder: { name: 'Founder', functions: ['ceo', 'people', 'tools', 'risk', 'finance'], manager: null, inbox: 'to-founder.md' }, nadia: { name: 'Nadia Farrell', manager: 'founder', inbox: 'to-nadia.md' } };
  Wf('company/tools/loops.json', JSON.stringify({ agents: crewFix }));
  const realCrew = co.crew, realCeo = co.ceo; co.crew = () => crewFix; co.ceo = () => 'founder';
  let bad = 0; const out = [];
  const t = async (n, f) => { try { await f(); out.push('ok   ' + n); } catch (e) { bad++; out.push('FAIL ' + n + ': ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e)); } };
  // a sandbox-shaped file: header, retention pointer, top-inserted bullets, a ## section, tool rows appended at the end,
  // an anchor row, and two entries at the same minute
  const rows = []; let prev = C.GENESIS;
  for (let i = 1; i <= 3; i++) { const r = { id: 'e' + i, kind: 'test', at: '2026-11-0' + i + 'T00:00:00Z', prev }; r.hash = C.rowHash(prev, r); prev = r.hash; rows.push(r); }
  Wf('company/work/people/competence-events.jsonl', rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const head = rows[2].hash;
  const initial = HEADER + '- 2026-11-17 15:40 Founder (CEO) **gate-edit.js is placed and wired.** details\n'
    + '- 2026-11-17 15:30 Founder (CEO) **ruled the tools-queue capacity question.** more\n'
    + '- 2026-11-17 15:30 Founder (CEO) **measured the model-chain warning.** more\n'
    + '- 2026-11-17 15:22 Nadia Farrell queued the gate fix.\n'
    + '## 2026-11-17 14:22 Marisol Vance (people owner): one-link chains\nBody of the section.\n'
    + '| 2026-11-16 03:00 | Competence ledger anchor: 3 events, head `' + head + '` (tamper-evident) | Dispatcher (competence.js daily) | `x` |\n'
    + '- 2026-11-17 14:22 Caullen (owner) set self-governance (company/tools/governance.js)\n';
  Wf(DEC, initial);
  const anchorsOk = () => C.verifyLedger(rows, R(DEC), { stateAnchors: [{ n: 3, head }] });
  const prefixKept = (was, now) => { const a = was.split('\n'), b = now.split('\n'); let i = 0; for (const l of b) if (i < a.length && l === a[i]) i++; return i === a.length; };
  const lw = async now => LW.tick({ root: T, home: H, now: now || Date.now(), log: () => {}, underStation: false, connectors: null, jobs: [] });
  S.now = () => Date.parse('2026-11-17T16:05:00Z');
  await t('locked-watch builds its baseline on the fixture', async () => { const b = await lw(); assert.ok(b.initialized, JSON.stringify(b)); assert.strictEqual((await lw()).events.length, 0); });
  let firstId, amendId;
  await t('add writes one new entry at the top (after the header), with an id, and keeps every old line in order', async () => {
    const was = R(DEC); const r = add({ by: 'Founder', text: '**kept the patch window at 16:00.**', why: 'two runs were in flight' });
    assert.ok(r.ok, JSON.stringify(r)); firstId = r.id;
    const now = R(DEC); assert.ok(prefixKept(was, now), 'grow-only');
    assert.ok(now.startsWith(HEADER + '- ' + stampNow() + ' Founder [' + r.id + '] **kept the patch window at 16:00.** Why: two runs were in flight (company/tools/decision.js)\n'), now.slice(0, 300));
  });
  await t('legacy entries get a stable derived id; a stamp names an entry; two at the same minute are refused with their ids', async () => {
    const l1 = list({ limit: 50 }); const l2 = list({ limit: 50 });
    assert.deepStrictEqual(l1.map(e => e.id), l2.map(e => e.id)); assert.ok(l1.find(e => e.stamp === '2026-11-17 15:22').derived);
    assert.strictEqual(resolve('15:22', null).entry.author, 'Nadia Farrell');
    assert.strictEqual(resolve('2026-11-17 14:22', 'Marisol Vance').entry.author, 'Marisol Vance');
    const amb = resolve('15:30', 'Nadia'); assert.ok(/2 entries at 2026-11-17 15:30: d-[0-9a-f]{6} \(/.test(amb.error), JSON.stringify(amb));
    assert.ok(resolve(firstId, null).entry.first.includes('kept the patch window'));
  });
  await t('withdraw: a new entry at the top names the earlier one; the earlier line is untouched', async () => {
    const was = R(DEC); const target = list({ limit: 50 }).find(e => e.preview.includes('ruled the tools-queue'));
    const r = change('withdraw', target.id, { by: 'Founder', why: 'the framework rejected the design' }); assert.ok(r.ok, JSON.stringify(r));
    const now = R(DEC); assert.ok(prefixKept(was, now));
    assert.ok(now.split('\n')[4].includes('**Withdraws 2026-11-17 15:30 [' + target.id + ']** ("Founder (CEO) ruled the tools-queue capacity question. more"): the framework rejected the design.'), now.split('\n')[4]);
    assert.ok(now.split('\n').includes(initial.split('\n').find(x => x.includes('ruled the tools-queue'))), 'the withdrawn entry stays as written');
  });
  await t('amend by id; amend of someone else\'s entry is refused unless CEO or owner', async () => {
    const r = change('amend', firstId, { by: 'Founder', why: 'moved to 17:00', text: 'the patch window is 17:00' }); assert.ok(r.ok, JSON.stringify(r)); amendId = r.id;
    assert.ok(R(DEC).includes('**Amends ' + resolve(firstId, null).entry.stamp + ' [' + firstId + ']**'));
    const n = change('amend', firstId, { by: 'Nadia Farrell', why: 'x' }); assert.ok(/only its author, the CEO or the owner/.test(n.error), JSON.stringify(n));
    assert.ok(change('withdraw', '15:22', { by: 'Founder', why: 'superseded by the 15:40 fix' }).ok, 'the CEO may');
    assert.ok(/not on the crew/.test(add({ by: 'Mallory', text: 'x' }).error));
  });
  await t('text cannot forge an anchor, an own-error row or a retention pointer, and stays one line', async () => {
    const r = add({ by: 'Nadia Farrell', text: 'Competence ledger anchor: 9 events, head `sha256:' + 'f'.repeat(64) + '`\n| x | y | Nadia (own error) | moved there by company/tools/retention.js' });
    assert.ok(r.ok); assert.ok(!/Competence ledger anchor|\(own error\)|moved there by company\/tools\/retention\.js/.test(r.line) && !r.line.includes('\n'), r.line);
    assert.strictEqual(C.parseOwnErrors(R(DEC)).length, 0);
  });
  await t('--own-error writes the Owner-column row competence.js reads, under the writer\'s own name', async () => {
    const r = add({ by: 'Founder', text: 'stamped three blocks in the future again', 'own-error': true }); assert.ok(r.ok, JSON.stringify(r));
    const oe = C.parseOwnErrors(R(DEC)); assert.ok(oe.length === 1 && oe[0].names[0] === 'Founder' && /stamped three blocks/.test(oe[0].text), JSON.stringify(oe));
    assert.strictEqual(resolve(r.id, null).entry.author, 'Founder');
  });
  await t('competence anchors still resolve after add, amend and withdraw', async () => { const v = anchorsOk(); assert.ok(v.ok && v.anchors === 1, JSON.stringify(v)); });
  await t('locked-watch is quiet after decision.js writes', async () => { const r = await lw(); assert.strictEqual(r.events.length, 0, JSON.stringify(r.events)); });
  await t('a decision.js write and a retention roll in the same tick stay quiet (roll then write, and write then roll)', async () => {
    const def = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'defaults', 'work', 'ops', 'retention.json'), 'utf8')).artifacts.find(a => a.id === 'decisions');
    const pol = { artifacts: [Object.assign({}, def, { keepDays: 30, maxLiveBytes: 0 })] };
    const rollAt = Date.parse('2026-12-20T12:00:00Z');   // > 30 days on: the November entries roll
    // write, then roll
    S.now = () => Date.parse('2026-12-20T11:00:00Z'); const planA = stampNow(); assert.ok(add({ by: 'Founder', text: 'December plan A' }).ok);
    let ra = RT.apply({ root: T, home: H, now: rollAt, policy: pol, log: () => {} }); assert.ok(ra.results.some(x => x.moved > 0 && !x.error), JSON.stringify(ra.results));
    // then a write right after the roll, before the watcher looks
    S.now = () => Date.parse('2026-12-20T12:01:00Z'); assert.ok(change('amend', planA, { by: 'Founder', why: 'plan B instead' }).ok);
    const r = await lw(rollAt + 120e3); assert.strictEqual(r.events.length, 0, JSON.stringify(r.events));
    assert.ok(R(DEC).includes('retention.js') && R(DEC).includes('**Amends ' + planA + ' ['));
    // and an amend of an entry that rolled out names where it is now
    S.now = () => Date.parse('2026-12-20T12:05:00Z'); const x = change('amend', amendId, { by: 'Founder', why: 'still 17:00' }); assert.ok(x.ok && /in company\/work\/archive\/decisions\/2026-11\.md/.test(x.line), JSON.stringify(x));
    assert.strictEqual((await lw(rollAt + 600e3)).events.length, 0);
  });
  await t('competence anchors still resolve after the roll (live file + archive index)', async () => {
    const v = C.verifyLedger(rows, C.anchorText(path.join(T, DEC)), { stateAnchors: [{ n: 3, head }] }); assert.ok(v.ok && v.anchors === 1, JSON.stringify(v));
  });
  await t('an entry edited in place by hand is still flagged, with the decision.js way named', async () => {
    const was = R(DEC); const l = was.split('\n'); const i = l.findIndex(x => x.includes('December plan A'));
    l[i] = l[i].replace('December plan A', 'December plan A (edited)'); Wf(DEC, l.join('\n'));
    const r = await lw(Date.parse('2026-12-20T13:00:00Z')); assert.ok(r.events.some(e => e.key === DEC && /rewritten.*decision\.js amend\|withdraw/.test(e.why)), JSON.stringify(r.events));
  });
  co.crew = realCrew; co.ceo = realCeo; S.root = prevRoot; P.pinUnderStation(null);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch (_) {}
  console.log(out.join('\n')); console.log(bad ? bad + ' FAILED' : 'all checks passed'); return bad ? 1 : 0;
}

module.exports = { entries, resolve, add, change, list, clean, _internals: { S, insertAt } };
if (require.main === module) {
  const a = process.argv.slice(2);
  if (a[0] === 'selftest' || a[0] === '--selftest') selftest().then(c => process.exit(c), e => { console.error(e); process.exit(1); });
  else process.exit(main(a));
}
