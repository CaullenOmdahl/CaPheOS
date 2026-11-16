#!/usr/bin/env node
/* owner-inbox.js — messages the owner sent the company, and whether the CEO has acted on them; and the one way the
 * company writes back to the owner.
 *
 * The owner channel is a pair of files (company/company.json ownerChannel, adapter "file"):
 *   company/owner/inbound.jsonl   owner -> company, one {id, at, from, text, re?} per line
 *   company/owner/outbound.jsonl  company -> owner, same shape
 * Any other adapter (a chat app, email) plugs in by writing and reading these same files. A message that names an
 * open question id (`re`, or "[q-123456]" in the text) is matched back to that question.
 *
 * The CEO reads unacknowledged messages every loop, acts, and acknowledges; the dispatcher wakes the seats flagged
 * wakeOnOwnerMessage while any message is unacknowledged. Nothing else reads the rest, so an unacknowledged message is
 * by definition one nobody has acted on.
 *
 *   node company/tools/owner-inbox.js new              # unacknowledged owner messages (JSON)
 *   node company/tools/owner-inbox.js count            # how many are unacknowledged (prints a number)
 *   node company/tools/owner-inbox.js ack --id <messageId> --by <name> --note "what was done with it"
 *   node company/tools/owner-inbox.js ack --all --by <name> --note "..."
 *   node company/tools/owner-inbox.js send --by <name> --text "..." [--re <id>]   # append to outbound.jsonl
 *   node company/tools/owner-inbox.js log              # the acknowledgement history
 *   node company/tools/owner-inbox.js --selftest       # offline fixtures
 *
 * State: company/state/owner-inbox.json { acked: { <messageId>: {by, at, note} } }. Messages are never deleted.
 * Env OWNER_DIR overrides company/owner (tests only).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const co = require('./lib/company');

const OWNER_DIR = () => process.env.OWNER_DIR || co.p('company', 'owner');
const INBOUND = () => path.join(OWNER_DIR(), 'inbound.jsonl');
const OUTBOUND = () => path.join(OWNER_DIR(), 'outbound.jsonl');
const STATE = () => process.env.OWNER_INBOX_STATE || co.p('company', 'state', 'owner-inbox.json');

function args() {
  const a = process.argv.slice(2); const o = { cmd: a[0] || 'new' };
  for (let i = 1; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const k = a[i].slice(2);
    o[k] = (a[i + 1] !== undefined && !a[i + 1].startsWith('--')) ? a[++i] : true;
  }
  return o;
}
const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fb; } };
function readLines(file) {
  let txt = ''; try { txt = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const l of txt.split('\n')) { if (!l.trim()) continue; try { const r = JSON.parse(l); if (r && r.id) out.push(r); } catch (_) {} }
  return out;
}
/* Owner messages. `text` is the field; `body` is accepted from adapters that still write it. */
function messages() {
  return readLines(INBOUND()).map(r => Object.assign({}, r, { text: String(r.text != null ? r.text : (r.body || '')) }));
}
function state() { const s = readJson(STATE(), {}); s.acked = s.acked || {}; return s; }
function unacked() {
  const s = state();
  return messages().filter(m => !s.acked[m.id]).map(m => {
    const q = m.re && /^q-\d+$/.test(String(m.re)) ? [null, String(m.re)] : String(m.text || '').match(/\[?(q-\d{6})\]?/);
    return { id: m.id, at: m.at, from: m.from || null, text: m.text, body: m.text, answersQuestion: q ? q[1] : null };
  });
}
/* Append one message to the owner (company -> owner). Returns the row written. */
// Nothing that looks like a key reaches the owner channel, whatever a tool or agent wrote: the value of every file in
// secrets/ plus common key shapes are masked before the line is written.
function redact(t) {
  let out = t;
  try { for (const f of fs.readdirSync(co.SECRETS_DIR)) { if (f === 'README.md') continue; const v = (co.secret(f) || '').trim(); if (v.length >= 12) out = out.split(v).join('[secret ' + f + ']'); } } catch (_) {}
  return out.replace(/\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, '[redacted key]');
}
function send({ from, text, re } = {}) {
  const body = redact(String(text || '').trim());
  if (!body) throw new Error('send: text is required');
  const row = { id: 'out-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6), at: new Date().toISOString(),
    from: String(from || co.nameOf(co.ceo()) || 'company'), text: body };
  if (re) row.re = String(re);
  fs.mkdirSync(path.dirname(OUTBOUND()), { recursive: true });
  fs.appendFileSync(OUTBOUND(), JSON.stringify(row) + '\n');
  return row;
}
function sent() { return readLines(OUTBOUND()); }
module.exports = { unacked, messages, send, sent, redact, INBOUND, OUTBOUND };

function selftest() {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-inbox-selftest-'));
  process.env.OWNER_DIR = dir; process.env.OWNER_INBOX_STATE = path.join(dir, 'state.json');
  const cases = []; const check = (n, c) => cases.push({ n, ok: !!c });
  fs.writeFileSync(INBOUND(), [
    JSON.stringify({ id: 'm1', at: '2026-01-01T00:00:00Z', from: 'owner', text: 'hello' }),
    JSON.stringify({ id: 'm2', at: '2026-01-01T00:01:00Z', from: 'owner', text: 'yes do it', re: 'q-123456' }),
    JSON.stringify({ id: 'm3', at: '2026-01-01T00:02:00Z', from: 'owner', body: 'legacy body [q-654321]' }),
    'not json',
  ].join('\n') + '\n');
  const u = unacked();
  check('three messages read, junk line skipped', u.length === 3);
  check('re field names the question', u[1].answersQuestion === 'q-123456');
  check('bracketed id in text names the question', u[2].answersQuestion === 'q-654321' && u[2].text === 'legacy body [q-654321]');
  fs.writeFileSync(STATE(), JSON.stringify({ acked: { m1: { by: 'Alex', at: 'x', note: 'y' } } }));
  check('acked message drops out', unacked().length === 2);
  const r = send({ from: 'Alex', text: 'a question', re: 'q-1' });
  check('send appends to outbound', sent().length === 1 && sent()[0].id === r.id && sent()[0].re === 'q-1');
  let threw = false; try { send({ text: '  ' }); } catch (_) { threw = true; }
  check('empty send refused', threw);
  for (const c of cases) console.log((c.ok ? 'ok   ' : 'FAIL ') + c.n);
  const bad = cases.filter(c => !c.ok).length;
  console.log(bad ? 'OWNER-INBOX SELFTEST FAILED: ' + bad : 'OWNER-INBOX SELFTEST PASSED: ' + cases.length + ' cases');
  return bad ? 1 : 0;
}

if (require.main === module) {
  if (process.argv.includes('--selftest')) process.exit(selftest());
  const a = args();
  const print = o => console.log(JSON.stringify(o, null, 1));
  if (a.cmd === 'new') { const u = unacked(); print({ ok: true, unacknowledged: u.length, messages: u }); process.exit(0); }
  if (a.cmd === 'count') { console.log(String(unacked().length)); process.exit(0); }
  if (a.cmd === 'log') { print({ ok: true, acked: state().acked }); process.exit(0); }
  if (a.cmd === 'send') {
    try { const r = send({ from: a.by, text: a.text, re: a.re }); print({ ok: true, id: r.id, file: path.relative(co.ROOT, OUTBOUND()) }); process.exit(0); }
    catch (e) { print({ ok: false, error: e.message }); process.exit(2); }
  }
  if (a.cmd === 'ack') {
    const by = String(a.by || '').trim(), note = String(a.note || '').trim();
    if (!by || !note) { print({ ok: false, error: '--by and --note are required (say what was done with the message)' }); process.exit(2); }
    const s = state(); const ids = a.all ? unacked().map(m => m.id) : [String(a.id || '')].filter(Boolean);
    const known = new Set(messages().map(m => m.id));
    const bad = ids.filter(id => !known.has(id));
    if (!ids.length || bad.length) { print({ ok: false, error: 'unknown or missing message id', bad }); process.exit(2); }
    for (const id of ids) s.acked[id] = { by, at: new Date().toISOString(), note: note.slice(0, 500) };
    fs.mkdirSync(path.dirname(STATE()), { recursive: true });
    fs.writeFileSync(STATE(), JSON.stringify(s, null, 1) + '\n');
    print({ ok: true, acked: ids.length, remaining: unacked().length }); process.exit(0);
  }
  print({ ok: false, error: 'unknown command', commands: ['new', 'count', 'ack', 'send', 'log', '--selftest'] }); process.exit(2);
}
