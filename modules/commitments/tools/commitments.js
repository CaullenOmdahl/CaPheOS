#!/usr/bin/env node
/* commitments.js — a state machine for anything the company can lose: a request, an order, a job, a lead.
 *
 *   received -> acknowledged -> in_progress -> done -> verified -> closed     (plus suppressed, cancelled, breached)
 *
 * One file per commitment in company/work/commitments/<id>.json and every transition appended to
 * company/work/commitments/commitments.jsonl. A commitment has a dedupe key (an open commitment with the same key is
 * returned, not duplicated), an owner seat (given as a seat id or a function, resolved with co.seatFor), an ack
 * deadline, a due time, an optional party and playbook, evidence refs and an optional verify spec.
 * The tick (modules/commitments/tick.js, run by the dispatcher) wakes owners with a handoff, re-escalates an
 * unacknowledged commitment to the owner seat's manager and then the CEO, and marks it breached past its due time.
 * It also writes company/work/commitments/open.json (open ones by due time) for the console panel.
 *
 *   node company/tools/commitments.js create --title "<t>" --key <k> --owner <fn|seat> [--party <id>] [--ack <min|ISO>]
 *        [--due <min|ISO>] [--playbook <id>] [--by <seat>] [--json]
 *   node company/tools/commitments.js ack|start|done|close|cancel|suppress <id> [--by <seat>] [--note ".."] [--evidence <ref>] [--json]
 *   node company/tools/commitments.js suppress --key <key> [--by ..]     # future creates with this key land suppressed
 *   node company/tools/commitments.js list [--open] [--party <id>] [--json]
 *   node company/tools/commitments.js show <id> [--json]
 *   node company/tools/commitments.js tick [--dry]
 *   node company/tools/commitments.js --selftest
 * Module: require('./commitments.js') -> { create, transition, get, list, tick, STATES, NEXT, TERMINAL }.
 * Limits (kit.limits: company/state/modules/<id>/limits/ once the owner opens them; shipped closed): maxOpen (open commitments at once).
 * Exit: 0 ok, 1 refused / not found, 2 usage.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const LIB = [path.join(__dirname, 'lib'), path.join(__dirname, '..', '..', '..', 'company', 'tools', 'lib')].find(d => fs.existsSync(path.join(d, 'modkit.js')));
const co = require(path.join(LIB, 'company'));
const kit = require(path.join(LIB, 'modkit'));

const STATES = ['received', 'acknowledged', 'in_progress', 'done', 'verified', 'closed', 'suppressed', 'cancelled', 'breached'];
const NEXT = {
  received: ['acknowledged', 'in_progress', 'suppressed', 'cancelled', 'breached'],
  acknowledged: ['in_progress', 'suppressed', 'cancelled', 'breached'],
  in_progress: ['done', 'cancelled', 'breached'],
  done: ['verified', 'in_progress', 'closed'],          // closed straight from done only without a verify spec
  verified: ['closed'],
  breached: ['acknowledged', 'in_progress', 'done', 'cancelled'],
  closed: [], suppressed: [], cancelled: [],
};
const TERMINAL = ['closed', 'suppressed', 'cancelled'];
const OPEN = s => !TERMINAL.includes(s) && s !== 'verified';
const VERB = { ack: 'acknowledged', start: 'in_progress', done: 'done', close: 'closed', cancel: 'cancelled', suppress: 'suppressed', verified: 'verified', reopen: 'in_progress' };
const FUNCTIONS = ['ceo', 'people', 'tools', 'risk', 'floor', 'finance'];

const DIR = () => co.p('company', 'work', 'commitments');
const LOG = () => path.join(DIR(), 'commitments.jsonl');
const SUPPRESS = () => path.join(DIR(), 'suppress.json');
const OPENF = () => path.join(DIR(), 'open.json');
const ID_RE = /^c-[0-9]{12}-[0-9a-f]{6}$/;
const file = id => { if (!ID_RE.test(String(id))) throw new Error('not a commitment id: ' + id); return path.join(DIR(), id + '.json'); };

function get(id) { try { return co.readJson(file(id), null); } catch (_) { return null; } }
function list(opts) {
  opts = opts || {};
  let fs_ = []; try { fs_ = fs.readdirSync(DIR()).filter(f => /^c-.*\.json$/.test(f)); } catch (_) {}
  return fs_.map(f => co.readJson(path.join(DIR(), f), null)).filter(Boolean)
    .filter(c => (!opts.open || OPEN(c.state)) && (!opts.party || c.party === opts.party))
    .sort((a, b) => String(a.dueAt || '9').localeCompare(String(b.dueAt || '9')) || a.createdAt.localeCompare(b.createdAt));
}
function save(c) { kit.writeJson(file(c.id), c); }
function when(v, now, fallbackMin) {
  if (v == null || v === '') return fallbackMin ? new Date(now + fallbackMin * 60000).toISOString() : null;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) return new Date(now + Number(v) * 60000).toISOString();
  const d = kit.iso(v); if (!d) throw new Error('not a time: ' + v + ' (minutes from now, or an ISO time)');
  return d;
}
function resolveOwner(o) {
  const crew = co.crew();
  if (o && crew[o]) return { owner: o, ownerFunction: null };
  if (o) { const byName = Object.keys(crew).find(k => String(crew[k].name || '').toLowerCase() === String(o).toLowerCase()); if (byName) return { owner: byName, ownerFunction: null }; }
  const fn = FUNCTIONS.includes(o) ? o : 'ceo';
  return { owner: co.seatFor(fn), ownerFunction: fn };
}
function suppressed(key) { const s = co.readJson(SUPPRESS(), {}) || {}; return (s.keys || []).includes(key); }
function writeOpen() {
  const rows = list({ open: true }).map(c => ({ id: c.id, title: c.title, state: c.state, owner: co.nameOf(c.owner), party: c.party || '',
    ackBy: c.ackBy, dueAt: c.dueAt, late: !!(c.dueAt && Date.parse(c.dueAt) < Date.now()) || c.state === 'breached', playbook: c.playbook || '' }));
  kit.writeJson(OPENF(), rows);
  return rows;
}

function create(o) {
  o = o || {};
  const now = o.now || Date.now();
  if (!o.title) throw new Error('a commitment needs a title');
  const key = String(o.key || o.title).slice(0, 300);
  const dup = list().find(c => c.key === key && OPEN(c.state));
  if (dup) return { ok: true, dedupe: true, commitment: dup };
  if (o.party) {
    const parties = kit.tool('parties');
    if (parties && !parties.exists(o.party)) throw new Error('unknown party: ' + o.party + ' (parties.js add it first)');
    if (!parties && !/^[a-z][a-z0-9-]{1,39}$/.test(o.party)) throw new Error('not a party id: ' + o.party);
  }
  const sup = suppressed(key);
  const max = kit.limit('commitments', 'maxOpen');
  if (!sup && list({ open: true }).length >= max) throw new Error('refused: the commitments limit maxOpen is ' + max + ' (limits ship closed; the owner opens them)');
  const at = new Date(now).toISOString();
  const c = Object.assign({ id: kit.newId('c'), key, party: o.party || null, title: String(o.title).slice(0, 300), state: 'received' },
    resolveOwner(o.owner), { createdAt: at, createdBy: o.by || 'unknown', ackBy: when(o.ackBy, now, 60), dueAt: when(o.dueAt, now, null),
      playbook: o.playbook || null, source: o.source || null, history: [], evidence: [].concat(o.evidence || []), verify: o.verify || null, escalations: [] });
  c.history.push({ at, from: null, to: 'received', by: c.createdBy, note: o.note || 'created' });
  kit.appendJsonl(LOG(), { at, id: c.id, key, from: null, to: 'received', by: c.createdBy, party: c.party });
  if (sup) { c.state = 'suppressed'; c.history.push({ at, from: 'received', to: 'suppressed', by: 'suppress-list', note: 'key is on the suppress list' }); kit.appendJsonl(LOG(), { at, id: c.id, key, from: 'received', to: 'suppressed', by: 'suppress-list', party: c.party }); }
  save(c); writeOpen();
  return { ok: true, commitment: c };
}

/* Flip the dispatcher's OPEN handoffs about this commitment to DONE once they no longer ask for anything. */
function closeHandoffs(c, note, onlyBreach) {
  const seats = new Set([c.owner, co.ceo()].concat((c.escalations || []).map(e => e.to)).filter(Boolean));
  for (const s of seats) {
    const inbox = (co.crew()[s] || {}).inbox; if (!inbox || /[\/\\]|\.\./.test(inbox)) continue;
    const f = co.p('company', 'work', 'handoffs', inbox);
    let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    const parts = txt.split(/^(?=## )/m); let changed = false;
    for (let i = 0; i < parts.length; i++) {
      const head = parts[i].split('\n')[0];
      if (!head.includes('from Dispatcher') || !parts[i].includes('**Commitment:** ' + c.id + ' ') || !/^\*\*Status:\*\*\s*OPEN\b/m.test(parts[i])) continue;
      if (onlyBreach === false && /BREACHED/.test(head)) continue;
      parts[i] = parts[i].replace(/^\*\*Status:\*\*\s*OPEN\b.*$/m, '**Status:** DONE — ' + note); changed = true;
    }
    if (changed) fs.writeFileSync(f, parts.join(''));
  }
}

function transition(id, to, by, note, evidence, now) {
  const c = get(id); if (!c) throw new Error('no such commitment: ' + id);
  if (!STATES.includes(to)) throw new Error('unknown state: ' + to);
  if (!(NEXT[c.state] || []).includes(to)) throw new Error('refused: ' + c.state + ' -> ' + to + ' is not a transition (allowed: ' + ((NEXT[c.state] || []).join(', ') || 'none, it is final') + ')');
  if (c.state === 'done' && to === 'closed' && c.verify) throw new Error('refused: this commitment has a verify spec; it closes only after verified');
  // Independent verification: nobody who did the work may mark it verified (the verify module's rule, enforced here
  // too so the CLI is not a way around it). The doers are the owner seat and everyone who moved it to work or done.
  if (to === 'verified') {
    const b = String(by || '').trim().toLowerCase().replace(/^verify:/, '');
    if (!b) throw new Error('refused: verified needs a named verifier (--by)');
    const doers = new Set([String(c.owner || '').toLowerCase(), String(co.nameOf(c.owner) || '').toLowerCase()]);
    for (const h of c.history || []) if (['acknowledged', 'in_progress', 'done'].includes(h.to)) doers.add(String(h.by || '').toLowerCase());
    if (doers.has(b)) throw new Error('refused: ' + by + ' did the work on ' + c.id + ' and can never mark it verified');
    if (c.verify && !/^verify(\.js)?$/.test(b) && !/^verify:/i.test(String(by || '').trim())) throw new Error('refused: ' + c.id + ' has a verify spec; only verify.js (run, or mark by a second seat) moves it to verified');
  }
  const at = new Date(now || Date.now()).toISOString();
  const row = { at, from: c.state, to, by: by || 'unknown', note: note || '' };
  c.history.push(row); c.state = to;
  if (to === 'acknowledged' || (to === 'in_progress' && !c.acknowledgedAt)) c.acknowledgedAt = at;
  for (const e of [].concat(evidence || [])) if (e && !c.evidence.includes(e)) c.evidence.push(e);
  save(c);
  kit.appendJsonl(LOG(), Object.assign({ id: c.id, key: c.key, party: c.party }, row));
  // acknowledging answers the wake and escalation handoffs; a final state (or done) answers all of them
  if (['acknowledged', 'in_progress'].includes(to)) closeHandoffs(c, 'commitment ' + to + ' by ' + row.by, false);
  if (['done', 'verified', 'closed', 'cancelled', 'suppressed'].includes(to)) closeHandoffs(c, 'commitment ' + to + ' by ' + row.by);
  writeOpen();
  return c;
}
function suppressKey(key, by) {
  const s = co.readJson(SUPPRESS(), {}) || {}; s.keys = s.keys || [];
  if (!s.keys.includes(key)) s.keys.push(key);
  kit.writeJson(SUPPRESS(), s);
  kit.appendJsonl(LOG(), { at: new Date().toISOString(), act: 'suppress-key', key, by: by || 'unknown' });
  return s;
}

/* The clock: wake, escalate, breach. Every effect is recorded on the commitment, so a tick is idempotent. */
function tick(opts) {
  opts = opts || {};
  const now = opts.now || Date.now(); const dry = !!opts.dry; const log = opts.log || (() => {});
  const crew = co.crew(); const ceo = co.ceo();
  const acts = [];
  const tell = (seat, heading, fields, c) => { if (!dry) kit.appendHandoff(seat, heading, Object.assign({ Commitment: c.id + ' (' + c.state + ')', Party: c.party || 'none', Key: c.key }, fields), 'Dispatcher'); acts.push({ id: c.id, seat, heading }); log('COMMITMENT ' + heading + ' -> ' + seat); };
  for (const c of list({ open: true })) {
    let changed = false;
    if (c.state === 'received' && !c.wokenAt) {
      tell(c.owner, 'commitment "' + c.title + '": acknowledge it', { Need: 'acknowledge with `node company/tools/commitments.js ack ' + c.id + ' --by <you>`, then work it (start, done).', Why: 'an unacknowledged commitment is escalated past its ack deadline.', Deadline: new Date(c.ackBy) }, c);
      c.wokenAt = new Date(now).toISOString(); changed = true;
    }
    if (c.state === 'received' && c.ackBy) {
      const window = Math.max(60000, Date.parse(c.ackBy) - Date.parse(c.createdAt));
      const lvl = (c.escalations || []).length;
      const dueAt = Date.parse(c.ackBy) + lvl * window;
      if (lvl < 2 && now > dueAt) {
        const mgr = crew[c.owner] && crew[c.owner].manager;
        let to = lvl === 0 && mgr && mgr !== c.owner ? mgr : ceo;
        if (lvl === 1 && (c.escalations[0] || {}).to === ceo) to = null;   // already at the CEO
        if (to) {
          tell(to, 'ESCALATED: commitment "' + c.title + '" not acknowledged by ' + co.nameOf(c.owner), { Need: 'get it acknowledged (or reassign it): `commitments.js show ' + c.id + '`.', Why: 'its ack deadline ' + kit.stamp(new Date(c.ackBy)) + ' passed.', Deadline: 'today' }, c);
        }
        c.escalations = (c.escalations || []).concat([{ at: new Date(now).toISOString(), level: lvl + 1, to: to || ceo }]); changed = true;
      }
    }
    if (c.dueAt && now > Date.parse(c.dueAt) && (NEXT[c.state] || []).includes('breached')) {
      if (!dry) { save(c); transition(c.id, 'breached', 'dispatcher', 'past due ' + c.dueAt, null, now); }
      const fresh = dry ? c : get(c.id);
      tell(c.owner, 'BREACHED: commitment "' + c.title + '" is past due', { Need: 'finish it or tell the CEO what happens now.', Why: 'it was due ' + kit.stamp(new Date(c.dueAt)) + '.', Deadline: 'today' }, fresh);
      if (ceo && ceo !== c.owner) tell(ceo, 'FYI BREACHED: commitment "' + c.title + '"', { Need: 'decide whether the party must be told.', Why: 'due ' + kit.stamp(new Date(c.dueAt)) + ', owner ' + co.nameOf(c.owner) + '.', Deadline: 'today' }, fresh);
      continue;
    }
    if (changed && !dry) save(c);
  }
  if (!dry) writeOpen();
  return { ok: true, acts };
}

module.exports = { create, transition, get, list, tick, suppressKey, writeOpen, STATES, NEXT, TERMINAL };

async function selftest(ok) {
  let r = null; try { create({ title: 'x', owner: 'ceo' }); } catch (e) { r = e.message; }
  ok('closed limit refuses a commitment', /maxOpen is 0/.test(r || ''), r);
  kit.setLimits(co.ROOT, 'commitments', { maxOpen: 10 });
  const t0 = Date.parse('2030-01-01T00:00:00Z');
  const a = create({ title: 'Answer the ticket', key: 'tk-1', owner: 'ops1', ackBy: 30, dueAt: 240, by: 'test', now: t0 }).commitment;
  ok('created as received with clocks', a.state === 'received' && a.ackBy === '2030-01-01T00:30:00.000Z' && a.dueAt === '2030-01-01T04:00:00.000Z', a);
  ok('dedupe by key returns the open one', create({ title: 'again', key: 'tk-1', owner: 'ceo', now: t0 }).dedupe === true);
  const fn = create({ title: 'fn', key: 'fn-1', owner: 'tools' }).commitment;
  ok('owner by function resolves to the seat', fn.owner === 'lead1' && fn.ownerFunction === 'tools');
  transition(fn.id, 'cancelled', 'test');
  r = null; try { transition(a.id, 'done', 'ops1'); } catch (e) { r = e.message; }
  ok('invalid transition refused (received -> done)', /not a transition/.test(r || ''), r);
  // tick 1: wake owner
  tick({ now: t0 + 60000 });
  const inbox = f => { try { return fs.readFileSync(co.p('company', 'work', 'handoffs', f), 'utf8'); } catch (_) { return ''; } };
  ok('owner woken with a handoff', /acknowledge it/.test(inbox('to-kim.md')) && /\*\*Status:\*\* OPEN/.test(inbox('to-kim.md')));
  tick({ now: t0 + 120000 });
  ok('waking is idempotent', (inbox('to-kim.md').match(/acknowledge it/g) || []).length === 1);
  tick({ now: t0 + 31 * 60000 });
  ok('past ack: escalated to the manager', /ESCALATED/.test(inbox('to-sam.md')) && !/ESCALATED/.test(inbox('to-alex.md')));
  tick({ now: t0 + 45 * 60000 });
  ok('no second escalation before the next window', !/ESCALATED/.test(inbox('to-alex.md')));
  tick({ now: t0 + 61 * 60000 });
  ok('then to the CEO', /ESCALATED/.test(inbox('to-alex.md')));
  tick({ now: t0 + 200 * 60000 });
  ok('escalation stops at the CEO', (inbox('to-alex.md').match(/ESCALATED/g) || []).length === 1);
  transition(a.id, 'acknowledged', 'ops1'); transition(a.id, 'in_progress', 'ops1');
  ok('acknowledging closes the wake and escalation handoffs', !/\*\*Status:\*\* OPEN/.test(inbox('to-kim.md')) && !/\*\*Status:\*\* OPEN/.test(inbox('to-sam.md')) && /DONE — commitment acknowledged/.test(inbox('to-alex.md')));
  tick({ now: t0 + 241 * 60000 });
  ok('past due: breached, owner and CEO told', get(a.id).state === 'breached' && /BREACHED/.test(inbox('to-kim.md')) && /FYI BREACHED/.test(inbox('to-alex.md')));
  transition(a.id, 'done', 'ops1', 'sent', 'company/work/x.md');
  ok('done carries evidence', get(a.id).evidence.includes('company/work/x.md'));
  ok('done closes the breach handoffs too', !/\*\*Status:\*\* OPEN/.test(inbox('to-kim.md') + inbox('to-alex.md')));
  transition(a.id, 'closed', 'ops1');
  ok('closed is final', get(a.id).state === 'closed' && NEXT.closed.length === 0);
  ok('jsonl has every transition', kit.readJsonl(LOG()).filter(x => x.id === a.id).map(x => x.to).join('>') === 'received>acknowledged>in_progress>breached>done>closed');
  const v = create({ title: 'verified one', key: 'v-1', owner: 'ceo', verify: { kind: 'file' } }).commitment;
  transition(v.id, 'in_progress', 'x'); transition(v.id, 'done', 'x');
  r = null; try { transition(v.id, 'closed', 'x'); } catch (e) { r = e.message; } ok('a verify spec blocks done -> closed', /verify spec/.test(r || ''));
  suppressKey('noise-1', 'test');
  ok('suppressed key lands suppressed', create({ title: 'noise', key: 'noise-1', owner: 'ceo' }).commitment.state === 'suppressed');
  ok('open.json written for the panel', Array.isArray(co.readJson(OPENF(), null)) && co.readJson(OPENF(), []).every(x => x.state !== 'closed'));
  r = null; try { create({ title: 'p', key: 'p1', party: '../x', owner: 'ceo' }); } catch (e) { r = e.message; } ok('bad party refused', /party/.test(r || ''), r);
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest') || argv[0] === 'selftest') { kit.runSelftest(__filename, 'commitments', selftest); return; }
  const a = kit.args(argv, ['open']);
  const out = (o, text) => console.log(a.json ? JSON.stringify(o, null, 2) : text);
  const [cmd, id] = a._;
  const line = c => c.id + '  ' + c.state.padEnd(12) + ' due ' + (c.dueAt || '-') + '  ' + co.nameOf(c.owner) + (c.party ? ' [' + c.party + ']' : '') + '  ' + c.title;
  try {
    if (cmd === 'create') { const r = create({ title: a.title, key: a.key, owner: a.owner, party: a.party, ackBy: a.ack, dueAt: a.due, playbook: a.playbook, by: a.by, note: a.note }); out(r, (r.dedupe ? 'exists ' : 'created ') + line(r.commitment)); }
    else if (cmd === 'suppress' && !id && a.key) { out(suppressKey(a.key, a.by), 'suppressing key ' + a.key); }
    else if (VERB[cmd] && cmd !== 'verified' && id) { const c = transition(id, VERB[cmd], a.by, a.note, a.evidence); out(c, line(c)); }
    else if (cmd === 'list') { const l = list({ open: !!a.open, party: a.party }); out(l, l.map(line).join('\n') || '(none)'); }
    else if (cmd === 'show') { const c = get(id); if (!c) { console.error('no such commitment: ' + id); process.exit(1); } out(c, JSON.stringify(c, null, 2)); }
    else if (cmd === 'tick') { const r = tick({ dry: !!(a.dry || a['dry-run']), log: console.log }); out(r, r.acts.length + ' act(s)'); }
    else { console.error('usage: commitments.js create|ack|start|done|close|cancel|suppress|list|show|tick|--selftest (see header)'); process.exit(2); }
  } catch (e) { console.error(e.message); process.exit(1); }
}
