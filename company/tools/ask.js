#!/usr/bin/env node
/* ask.js — route a question to the right level, and refuse to route non-CEO questions to the CEO.
 *
 *   node company/tools/ask.js --from Alex --topic design --q "which card layout?" [--blocking]
 *   node company/tools/ask.js --from Sam --topic ceo --q "should we cut the second platform phase?" --blocking
 *   node company/tools/ask.js list
 *   node company/tools/ask.js owners
 *
 * Every question is recorded in company/asks.jsonl with its routed owner and level. Topics route by FUNCTION, never
 * by name: each topic names the function that owns it (company/tools/lib/company.js seatFor), and the holder is looked
 * up in loops.json at the moment of asking, so a hire or a departure changes the route without a code change. A seat
 * may also claim specialist topics outright with `topics: ["design", ...]` in its loops.json row; that wins over the
 * function. A question routed to a function owner never lands in the CEO's inbox. Only --topic ceo reaches the CEO.
 * The PM gates stay in inbox.js (money, access, ownership, commitment) and are raised by the CEO, not by specialists.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const co = require('./lib/company');
const LOG = co.p('company', 'asks.jsonl');
const ROUTES = {
  design: { fn: 'ceo', level: 'specialist', note: 'visual/copy specifics; the product owner ratifies product intent' },
  copy: { fn: 'ceo', level: 'specialist', note: 'wording and tone' },
  product: { fn: 'ceo', level: 'owner', note: 'scope, acceptance criteria, wording' },
  engineering: { fn: 'tools', level: 'owner', note: 'code, tooling, harness config' },
  tooling: { fn: 'tools', level: 'owner', note: 'skills, agents, station service' },
  deploy: { fn: 'tools', level: 'owner', note: 'CI, release, deploy mechanics' },
  security: { fn: 'risk', level: 'owner', note: 'secrets, permissions, dependency risk' },
  finance: { fn: 'finance', level: 'owner', note: 'spend inside budget, ledger, cost tradeoffs' },
  hiring: { fn: 'people', level: 'owner', note: 'roles, screening, hiring process' },
  people: { fn: 'people', level: 'owner', note: 'performance, model changes, replacing a person, picking a hire (with the person\'s manager)' },
  floor: { fn: 'floor', level: 'owner', note: 'desks, rooms, layout' },
  research: { fn: 'ceo', level: 'specialist', note: 'sourced research' },
  ceo: { fn: 'ceo', level: 'ceo', note: 'strategy, priorities, cross-function, opening new roles, risk, external commitments' },
};
/* station id that owns a topic right now: a seat that claims the topic, else the function holder (CEO as last resort). */
function ownerOf(topic) {
  const r = ROUTES[topic]; if (!r) return null;
  if (r.level !== 'ceo') {
    const c = co.crew();
    const claim = Object.keys(c).find(id => c[id] && Array.isArray(c[id].topics) && c[id].topics.map(String).map(t => t.toLowerCase()).includes(topic));
    if (claim) return claim;
  }
  return r.fn === 'ceo' ? co.ceo() : co.seatFor(r.fn);
}
const resolve = topic => { const id = ownerOf(topic); return Object.assign({}, ROUTES[topic], { toId: id, to: id ? co.nameOf(id) : 'the CEO' }); };
const CEO_ID = co.ceo();
const CEO = CEO_ID ? co.nameOf(CEO_ID) : 'the CEO';
const CEO_LEVEL = new Set(['ceo']);
const PM_GATES = ['money', 'access', 'ownership', 'commitment'];

function args() {
  const a = process.argv.slice(2); const o = { cmd: a[0] && !a[0].startsWith('--') ? a[0] : 'ask' };
  const start = o.cmd === 'ask' ? 0 : 1;
  for (let i = start; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const k = a[i].slice(2);
    o[k] = (a[i + 1] !== undefined && !a[i + 1].startsWith('--')) ? a[++i] : true;
  }
  return o;
}
function out(code, obj) { console.log(JSON.stringify(obj, null, 1)); process.exit(code); }
const a = args();

if (a.cmd === 'owners') {
  out(0, { ok: true, routes: Object.keys(ROUTES).map(topic => { const r = resolve(topic); return { topic, function: r.fn, to: r.to, toId: r.toId, level: r.level, note: r.note }; }), pmGates: PM_GATES, ceo: CEO });
}
if (a.cmd === 'list') {
  let rows = [];
  try { rows = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (_) {}
  out(0, { ok: true, count: rows.length, asks: rows.slice(-50) });
}

const from = String(a.from || '').trim();
const topic = String(a.topic || '').trim().toLowerCase();
const q = String(a.q || '').trim();
if (!from || !topic || !q) out(2, { ok: false, error: 'usage: ask.js --from <agent> --topic <topic> --q "<question>"', topics: Object.keys(ROUTES) });
const route = ROUTES[topic] ? resolve(topic) : null;
if (!route) out(2, { ok: false, error: 'unknown topic "' + topic + '"', topics: Object.keys(ROUTES) });

// a specialist may not address the CEO directly unless the topic is genuinely CEO-level
const addressedTo = String(a.to || '').trim();
const toCeo = t => { const x = t.toLowerCase(); return x === 'ceo' || x === String(CEO).toLowerCase() || (CEO_ID && x === String(CEO_ID).toLowerCase()); };
if (addressedTo && toCeo(addressedTo) && !CEO_LEVEL.has(route.level)) {
  out(3, {
    ok: false,
    refused: true,
    reason: 'this is a ' + route.level + '-level question; the CEO (' + CEO + ') does not answer it',
    route: { to: route.to, toId: route.toId, function: route.fn, topic },
  });
}
const row = {
  at: new Date().toISOString(),
  from, topic, q,
  routedTo: route.to, routedToId: route.toId, function: route.fn, level: route.level, note: route.note,
  blocking: !!a.blocking,
  addressedTo: addressedTo || route.to,
  pmGate: false,
};
fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.appendFileSync(LOG, JSON.stringify(row) + '\n');
out(0, {
  ok: true,
  routed: { topic, from, to: route.to, toId: route.toId, function: route.fn, level: route.level },
  why: route.note,
  answerToExpect: route.level === 'ceo'
    ? 'the CEO decides and records it; only the four PM gates go up from here'
    : 'the function owner decides; only a gate failure goes up the chain',
  pmGate: false,
});
