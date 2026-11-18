'use strict';
/* tests/helpers/owner-stubs.js — stand-ins for lib/owner-card.js and lib/owner-notice.js that follow their shared contract,
 * for selftests and node --test files of the tools that call them (harness-change.js, service.js).
 *
 * The stand-ins decide scope the way the contract says (a fixed gate or a category at approve is filed; auto goes back to
 * the crew; notify becomes one digest line), refuse an owner text that does not read plainly (lib/owner-scope.js
 * plainScore, code NOT_PLAIN), dedupe by ref, and write the card through lib/pm-inbox-guard.js so lib/governance.js
 * approved(ref) reads it like a real card. They never decide anything the real modules would not, and they exist only so
 * a tool's own tests do not depend on another branch's file. Every call is kept in `.calls` / `.sent` for assertions.
 */
const fs = require('fs');
const path = require('path');

function makeOwnerCard(root, opts) {
  opts = opts || {};
  const inbox = path.join(root, 'company', 'pm-inbox.jsonl');
  const G = require('../../lib/pm-inbox-guard');
  const gov = require('../../lib/governance');
  const scope = require('../../lib/owner-scope');
  const calls = [];
  const rows = () => { try { return G.rows({ file: inbox }); } catch (_) { return []; } };
  const openFor = ref => {
    const all = rows();
    const done = new Set(all.filter(r => ['answer', 'close', 'withdraw', 'reclassify'].includes(r.type)).map(r => r.id));
    return all.filter(r => r.type === 'ask' && r.gate && r.gate.ref === ref && !done.has(r.id)).pop() || null;
  };
  let n = 0;
  return {
    calls,
    file(c) {
      calls.push({ op: 'file', card: c });
      for (const k of ['lead', 'consequence', 'recommendation']) {
        const s = scope.plainScore(String(c[k] || ''), { approval: true });
        if (!s.ok) { const e = new Error('not plain (' + k + '): ' + s.problems.join('; ') + ' — ' + String(c[k] || '')); e.code = 'NOT_PLAIN'; throw e; }
      }
      if (!c.ref) throw new Error('a card needs a ref');
      const rulings = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, 'company', 'state', 'owner-rulings.json'), 'utf8')).rulings || []; } catch (_) { return []; } })();
      const hit = !c.fixedGate && !c.guardrail && rulings.find(r => r.effect === 'crew-decides' && r.scope && (r.scope.categories || []).includes(c.category));
      if (hit) return { filed: false, reason: 'a standing owner ruling lets the crew decide', route: 'ruling', ruling: { id: hit.id, text: hit.text, effect: hit.effect } };
      const lv = c.fixedGate || c.guardrail ? 'approve' : gov.level(c.category, { root });
      if (lv === 'auto') return { filed: false, reason: c.category + ' is at auto', route: 'crew' };
      if (lv === 'notify') { if (opts.notice) opts.notice.send({ kind: 'fyi', from: c.asker, text: c.lead, technical: c.technical, key: c.ref }); return { filed: false, reason: c.category + ' is at notify', route: 'digest' }; }
      const open = openFor(c.ref);
      if (open) return { filed: false, reason: 'an open card has this ref', route: 'duplicate', id: open.id };
      const used = new Set(rows().map(r => r.id));
      let id; do { id = 'q-' + String(900000 + (n++)).padStart(6, '0'); } while (used.has(id));
      const row = { type: 'ask', id, at: new Date().toISOString(), from: c.asker, about: 'card:' + c.ref, message: c.lead, details: c.consequence + '\n' + c.recommendation,
        q: c.lead + '\n\n' + c.consequence + '\n' + c.recommendation, technical: c.technical || '', effect: c.effect || { none: true }, blocking: false, batch: 'gate',
        gate: { ref: c.ref, category: c.category, fixedGate: c.fixedGate || null, guardrail: c.guardrail || undefined } };
      G.append(inbox, row, 'harness-change.js');
      return { filed: true, id };
    },
    withdraw(w) {
      calls.push({ op: 'withdraw', w });
      const open = openFor(w.ref); if (!open) return { withdrawn: false };
      G.append(inbox, { type: 'withdraw', id: open.id, by: open.from, why: w.why || 'withdrawn', at: new Date().toISOString() }, 'harness-change.js');
      return { withdrawn: true, id: open.id };
    },
    openFor,
  };
}

function makeOwnerNotice() {
  const sent = [];
  return { sent, send(o) { sent.push(o); return { ok: true, kind: o.kind }; } };
}

module.exports = { makeOwnerCard, makeOwnerNotice };
