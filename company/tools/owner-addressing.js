#!/usr/bin/env node
/* owner-addressing.js — decide WHO an owner message is for, by the name the owner writes first.
 *
 * The owner should not have to carry a question id in their head to be heard: "Alex, can you address issue 999" is
 * how people write. Before this, the only provable link between an owner message and a question was the
 * `[?q-\d{6}]?` match.
 *
 * The rule, and it is deliberately boring:
 *   1. A message that OPENS with a crew name — "Alex, …", "alex: …", "Sam\n…", case-insensitive, comma/colon
 *      optional — is addressed to that person. The CEO ⇒ the CEO's inbox (`owner-inbox.js new`), anyone else ⇒ that
 *      person's handoff inbox (loops.json `inbox`).
 *   2. No name, no q-id ⇒ unchanged behaviour: it stays in `company/owner/inbound.jsonl` and the CEO reads it. The
 *      route is still LOGGED, because "which road did this take" is the question an auditor asks.
 *   3. A q-id is a second signal, never the only one. If the name and the q-id disagree, THE NAME WINS and the
 *      conflict is logged.
 *   4. Every message gets one plain acknowledgement line naming whose hands it is in, and no ids in it.
 *   5. Only names of people who exist in `company/tools/loops.json` at the moment of routing count (read at runtime,
 *      so a hire or a departure needs no code change). A possessive ("Alex's plan is…"), a name inside a sentence
 *      ("I told Alex"), or a longer word that starts with a name are NOT addressees — a false positive sends the
 *      owner's instruction to the wrong person and nobody notices.
 *
 *   node company/tools/owner-addressing.js route --body "Alex, can you address issue 999"
 *   node company/tools/owner-addressing.js dispatch [--apply] [--limit 20]   # route unprocessed inbound messages
 *   node company/tools/owner-addressing.js --selftest                          # fixtures (invented crew) + the negatives
 *
 * State: company/state/owner-addressing.json { routed: { <messageId>: {at, addressee, inbox, ack} } }.
 * `dispatch` without --apply writes nothing and prints what it would do.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const co = require('./lib/company');
const ROOT = co.ROOT;
const STATE = co.p('company', 'state', 'owner-addressing.json');
const HANDOFFS = co.p('company', 'work', 'handoffs');

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');

// The crew: every agent in loops.json, keyed by the normalised name the owner would type. The CEO is the seat that
// holds the `ceo` function (or has no manager), never a fixed id or name.
function crewFrom(agents) {
  const by = {};
  const ids = Object.keys(agents || {});
  const ceoId = ids.find(id => co.holds(agents[id], 'ceo')) || ids.find(id => agents[id] && agents[id].manager == null) || null;
  for (const id of ids) {
    const a = agents[id];
    if (!a || !a.name) continue;
    // first name only: "Alex Kim" is addressed as "Alex"
    const first = String(a.name).trim().split(/\s+/)[0];
    by[norm(first)] = { id, name: String(a.name), inbox: a.inbox || ('to-' + id + '.md'), isCeo: id === ceoId };
  }
  return by;
}
function crew() {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(co.LOOPS_FILE, 'utf8')); } catch (_) { return { error: 'loops.json unreadable' }; }
  return crewFrom((doc && doc.agents) || {});
}
const ceoName = () => { const id = co.ceo(); return id ? co.nameOf(id) : 'the CEO'; };

/* The addressee rule, in one function so the test and the product cannot drift apart.
 * Returns { addressee, name, to, inbox, isCeo, how } — or { addressee:null, how:'none' }. */
function route(body, crewMap) {
  const by = crewMap || crew();
  if (by.error) return { addressee: null, how: 'error', reason: by.error };
  const text = String(body || '');
  // The opening token: letters only, at most 15 of them, followed by end/comma/colon/whitespace.
  // A possessive ("Alex's") is captured by the same token, which is why it is checked and rejected below.
  const m = text.match(/^\s*([A-Za-z\u00C0-\u024F]{2,15})(['’]s)?\s*([,:;\-–—]|\n|$|\s)/);
  if (!m) return { addressee: null, how: 'none' };
  const [, word, possessive] = m;
  const hit = by[norm(word)];
  if (!hit) return { addressee: null, how: 'none', firstWord: word };
  if (possessive) return { addressee: null, how: 'possessive', firstWord: word };       // "Alex's plan is late"
  // "Alex, can you…" and "Alex\nwhat did…" and "Alex: check…" are addressed; "Alex asked me to…" is not, and the
  // difference is the separator: a name opening a sentence followed by a comma/colon/newline/end, not by a verb.
  const sep = m[3];
  if (!(sep === undefined || sep === ',' || sep === ':' || sep === ';' || sep === '—' || sep === '–' || sep === '-' || sep === '\n' || sep === '')) return { addressee: null, how: 'not-a-salutation', firstWord: word };
  const person = hit;
  return {
    addressee: person.name,
    how: 'opening-name',
    to: person.isCeo ? 'ceo' : 'agent',
    agentId: person.id,
    inbox: person.isCeo ? 'owner-inbox.js new (no file write)' : 'company/work/handoffs/' + person.inbox,
    isCeo: !!person.isCeo,
  };
}

function questionId(body) {
  const m = String(body || '').match(/\[?(q-\d{6})\]?/);
  return m ? m[1] : null;
}

// The plain acknowledgement (requirement 4): whose hands it is in, no ids, one line.
function acknowledgement(r, qid) {
  if (r.error) return null;
  if (r.addressee && r.isCeo) return 'Got it — that is with ' + r.addressee + ', the CEO, who will answer here.';
  if (r.addressee) return 'Got it — that is with ' + r.addressee + '. It is in their inbox now.';
  if (qid) return 'Got it — that is with the company, filed against the question you named.';
  return 'Got it — that is with the company. ' + ceoName() + ', the CEO, reads everything that arrives here.';
}

// One decision record for one message: the addressee, the q-id, which of the two won, and the ack.
function decide(body, crewMap) {
  const r = route(body, crewMap);
  const qid = questionId(body);
  const conflict = !!(r.addressee && qid);
  return Object.assign({}, r, {
    questionId: qid,
    conflict,
    conflictRule: conflict ? 'name wins; q-id recorded as a second signal' : null,
    ack: acknowledgement(r, qid),
  });
}

/* ---- dispatch: read the inbound log and route what has not been routed yet ---- */
// company/owner/inbound.jsonl rows {id, at, from, text, re?}; `body` is accepted from adapters that still write it.
function inboundMessages() {
  try { return require('./owner-inbox.js').messages(); } catch (_) { return []; }
}
function inboundFrom(txt) {
  const out = [];
  for (const l of String(txt).split('\n')) { if (!l.trim()) continue; try { const r = JSON.parse(l); if (r && r.id) out.push(Object.assign({}, r, { text: String(r.text != null ? r.text : (r.body || '')) })); } catch (_) {} }
  return out;
}

function dispatch(opts) {
  const stateFile = opts.state || STATE;
  const st = (() => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_) { return { routed: {} }; } })();
  st.routed = st.routed || {};
  const source = opts.inbound ? inboundFrom(opts.inbound) : inboundMessages();
  const pending = source.filter(m => !st.routed[m.id]).slice(0, opts.limit || 20);
  const done = [];
  for (const m of pending) {
    const d = decide(m.text, opts.crew);
    const rec = { at: new Date().toISOString(), id: m.id, addressee: d.addressee || null, to: d.to || null,
      inbox: d.inbox || null, questionId: d.questionId, conflict: d.conflict, ack: d.ack, applied: !!opts.apply };
    if (opts.apply) {
      if (d.addressee && !d.isCeo) {
        const file = path.join(opts.handoffs || HANDOFFS, (d.inbox || '').replace(/^company\/work\/handoffs\//, ''));
        const lp = co.localParts();
        const block = '\n## ' + lp.date + ' ' + lp.time + ' from ' + co.config.owner.name + ' (owner, via the owner channel) — addressed to you by name\n'
          + '**Need:** ' + String(m.text || '').trim().slice(0, 2000).replace(/\n{3,}/g, '\n\n') + '\n'
          + '**Why:** the owner opened the message with your name, so `owner-addressing.js` routed it here instead of to the CEO (message id `' + m.id + '`' + (d.questionId ? ', q-id `' + d.questionId + '` present and noted' : '') + ').\n'
          + '**Status:** OPEN\n';
        fs.mkdirSync(path.dirname(file), { recursive: true }); require('./lib/tool-blocks').append(file, block, opts.handoffs ? { root: path.dirname(path.resolve(opts.handoffs)) } : undefined);   // recorded (lib/tool-blocks.js): the owner's message, routed by this tool, never held as a member's message
        rec.wroteTo = path.relative(ROOT, file);
      }
      st.routed[m.id] = rec;
    }
    done.push(rec);
  }
  if (opts.apply) { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(st, null, 1) + '\n'); }
  return { ok: true, applied: !!opts.apply, considered: pending.length, routed: done };
}

/* ---- SELFTEST: fixtures on an invented crew (CEO Alex, plus Sam and Robin), plus the false positives the rule must refuse ---- */
const FIXTURE_CREW = {
  ceo1: { name: 'Alex', functions: ['ceo'], inbox: 'to-alex.md', manager: null },
  ppl1: { name: 'Sam Lee', functions: ['people'], inbox: 'to-sam.md', manager: 'ceo1' },
  fin1: { name: 'Robin', functions: ['finance'], inbox: 'to-robin.md', manager: 'ceo1' },
};
function selftest() {
  const by = crewFrom(FIXTURE_CREW);
  const cases = [
    ['Alex, can you address issue 999',                      'ceo',   'Alex',    'the plain CEO instruction'],
    ['alex: check the price',                                'ceo',   'Alex',    'lower case, colon'],
    ['Sam, get me a QA hire',                                'agent', 'Sam Lee', 'a crew name that is not the CEO (first name of a full name)'],
    ['Robin\nwhat did the invoice check say',                'agent', 'Robin',   'name then newline, no punctuation'],
    ['the wifi at the office dropped again this morning',    'none',  null,      'unaddressed: unchanged route, logged as none'],
    ['Robin, 46ff0857 (q-801852) was never answered',        'agent', 'Robin',   'name vs q-id: name wins, conflict recorded'],
    // the false positives the rule must refuse (requirement 5)
    ["Alex's plan for Thursday looks right",                 'none',  null,      'possessive is not an addressee'],
    ['I told Alex the price yesterday',                       'none',  null,      'a name inside a sentence is not an addressee'],
    ['Robin Street opens at seven',                           'none',  null,      'a name followed by a word is not a salutation'],
    ['Samantha said the app crashed',                         'none',  null,      'a longer word starting with a name is not that name'],
    ['Jordan, are you there',                                 'none',  null,      'a name not on the crew is not an addressee'],
  ];
  let bad = 0;
  const rows = [];
  for (const [body, wantTo, wantName, why] of cases) {
    const d = decide(body, by);
    const gotTo = d.addressee ? d.to : 'none';
    const ok = gotTo === wantTo && (wantName === null ? d.addressee === null : d.addressee === wantName);
    if (!ok) bad++;
    rows.push((ok ? 'ok   ' : 'FAIL ') + JSON.stringify(body).slice(0, 52).padEnd(53) + ' → '
      + String(d.addressee || '(unaddressed)').padEnd(8) + ' via ' + (d.to || 'none') + (d.conflict ? ' [conflict: name over ' + d.questionId + ']' : '')
      + '   — ' + why);
  }
  // the acknowledgement must never contain an id (requirement 4)
  const ackBad = cases.map(([b]) => decide(b, by).ack).filter(a => a && /q-\d{6}|\b[0-9a-f]{8}\b/.test(a));
  // a conflict must set the rule, and a message with no name and no id must still be routed somewhere real
  const conflict = decide('Robin, 46ff0857 (q-801852) was never answered', by).conflict;
  const nowhere = decide('hello', by);
  if (!conflict) { bad++; rows.push('FAIL conflict not recorded when a name and a q-id disagree'); }
  if (nowhere.to) { bad++; rows.push('FAIL an unaddressed message was given a destination'); }
  if (ackBad.length) { bad++; rows.push('FAIL an acknowledgement carried an id: ' + JSON.stringify(ackBad[0])); }
  /* dispatch's WRITE path, on fixtures: a named non-CEO message must land in that person's inbox verbatim, a CEO
     message must write to no inbox at all (the CEO reads it where it already is), and an unaddressed one must write
     nothing. Without this the decision is tested and the file it writes is not. */
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addressing-'));
  fs.mkdirSync(path.join(dir, 'handoffs'), { recursive: true });
  const fixture = [
    { id: 'm-sam', at: '2026-01-01T00:00:00Z', from: 'owner', text: 'Sam, get me a QA hire please' },
    { id: 'm-alex', at: '2026-01-01T00:01:00Z', from: 'owner', text: 'Alex, can you address issue 999' },
    { id: 'm-none', at: '2026-01-01T00:02:00Z', from: 'owner', body: 'the wifi at the office dropped again' },
  ].map(x => JSON.stringify(x)).join('\n') + '\n';
  const opts = { apply: true, inbound: fixture, crew: by, state: path.join(dir, 'state.json'), handoffs: path.join(dir, 'handoffs') };
  const r1 = dispatch(opts);
  const samFile = path.join(dir, 'handoffs', 'to-sam.md');
  const wrote = fs.existsSync(samFile) ? fs.readFileSync(samFile, 'utf8') : '';
  const written = fs.readdirSync(path.join(dir, 'handoffs'));
  const caseOk = wrote.includes('get me a QA hire please') && wrote.includes('**Status:** OPEN')
    && written.length === 1 && written[0] === 'to-sam.md'          // exactly one file: no CEO write, no unaddressed write
    && r1.routed.find(x => x.id === 'm-none').wroteTo === undefined;
  if (!caseOk) bad++;
  rows.push((caseOk ? 'ok   ' : 'FAIL ') + 'dispatch writes the named message into to-sam.md (' + wrote.length + ' chars); the handoffs directory ends with exactly [' + written.join(',') + '], so nothing is written for the CEO message or the unaddressed one');
  // and it must not re-route the same message twice (state, not guesswork)
  const r2 = dispatch(opts);
  const idempotent = r2.considered === 0;
  if (!idempotent) bad++;
  rows.push((idempotent ? 'ok   ' : 'FAIL ') + 'a second dispatch considers ' + r2.considered + ' messages (already-routed ones are not written twice)');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  console.log(rows.join('\n'));
  console.log('');
  console.log(bad ? 'SELFTEST FAILED: ' + bad + ' case(s) wrong — the owner\'s instruction can reach the wrong person'
    : 'SELFTEST PASSED: ' + cases.length + ' messages routed as specified, ' + cases.filter(c => c[1] === 'none').length
      + ' of them correctly left unaddressed, the conflict rule holds, and no acknowledgement carries an id');
  return bad ? 1 : 0;
}

module.exports = { route, decide, dispatch, acknowledgement, questionId, crew, crewFrom };

if (require.main === module) {
  const a = process.argv.slice(2);
  const opt = n => { const i = a.indexOf('--' + n); return i === -1 ? null : (a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true); };
  if (a.includes('--selftest')) process.exit(selftest());
  const cmd = a[0] || 'route';
  if (cmd === 'route') {
    const body = opt('body');
    if (body === null) { console.log(JSON.stringify({ ok: false, error: 'route needs --body "<the owner message>"' })); process.exit(2); }
    console.log(JSON.stringify(Object.assign({ ok: true }, decide(String(body))), null, 1));
    process.exit(0);
  }
  if (cmd === 'dispatch') {
    const r = dispatch({ apply: !!opt('apply'), limit: Number(opt('limit')) || 20 });
    console.log(JSON.stringify(r, null, 1));
    process.exit(r.ok ? 0 : 1);
  }
  console.log('usage: owner-addressing.js route --body "…" | dispatch [--apply] [--limit N] | --selftest');
  process.exit(2);
}
