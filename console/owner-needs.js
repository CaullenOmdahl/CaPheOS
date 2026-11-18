'use strict';
/* console/owner-needs.js — which open cards still need the owner, standing owner rulings, a yes that does what it asks,
 * and the daily plain digest. Mounted by console/server.js; every write here runs in the console process (the owner's
 * UI behind the owner token: company/tools/lib/owner.js shell()).
 *
 * Owner direction 2026-11-18: "It's asking me for permissions for a lot of things that we've already scoped agents for
 * permission to do … people who are non-technical need to be able to use this."
 *
 * NEEDS YOU (classify): an open card still needs the owner only when
 *   - it is one of the four fixed owner gates (governance.json `fixed`: access, ownership, commitment, spendBeyondCap;
 *     row.gate.fixedGate, an approval record's category, or the card's category), and no ruling ever hides one; or
 *   - its category's LIVE level (lib/governance.js level(), read now, not the level when it was filed) is approve
 *     (triage reads as approve: a filed triage card was escalated), and no standing ruling says the crew decides; or
 *   - it has no category, and it asks for a key or an account (access), or the owner-scope rule (lib/owner-scope.js
 *     classify) reads it as the owner's (money, account, legal, direction); or
 *   - a standing ruling with effect 'ask' covers it.
 * Every other open card is "The crew is handling" on Today: read only, not in the badge, with who and a plain line.
 *
 * STANDING RULINGS: company/state/owner-rulings.json
 *   { rulings: [{ id, at, by: 'owner', text (the owner's words), scope: { categories?: [...], topics?: [...] },
 *                 effect: 'crew-decides' | 'never-ask' | 'ask' }] }
 * Read, matched and written through company/tools/lib/owner-rulings.js (the same file, reader and matcher lib/owner-card.js
 * uses before it files a card, so the console and the tools never disagree about what a ruling covers). Writes are
 * owner-only (lib/owner.js: the console is an owner path) and recorded in the provenance log (writer "owner-rulings").
 * The fixed gates always override a ruling, and a ruling cannot name one.
 *
 * TYPED EFFECTS (applyEffect): a card may carry `effect`, applied only here, only after the owner's own yes:
 *   {serviceApprove:{name}}  service.js owner-approve   (filed only by service.js)
 *   {harnessApply:{id}}      harness-change.js owner-apply (filed only by harness-change.js)
 *   {none:true}              nothing
 * lib/pm-inbox-guard.js drops the effect of a card whose recorded writer is not the tool that owns it, and every other
 * effect kind has no producer and is never applied. The card shows what yes does in the console's own words
 * (describeEffect: every parameter, in plain words), never the asker's. cardDigest(row) is a hash of the card exactly as
 * shown (its words, its technical part, its effect and what yes does): the page sends it back with the answer, and the
 * effect is applied only when the card still hashes to what the owner saw (an asker's later update never rides on a yes).
 *
 * DIGEST: company/owner/digest.jsonl {at, kind:'fyi', from, text, technical?, key?} (company/tools/lib/owner-notice.js
 * writes it); Today shows the last day of it as one card.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LEVEL_SAY = { auto: 'the crew decides', notify: 'the crew decides and tells you', triage: 'a check decides, or asks you', approve: 'you decide' };
const CAT_SAY = { hiring: 'hiring', release: 'releasing someone', budget: 'the budget', spend: 'spending inside the cap', models: 'which AI models the crew uses',
  tools: 'changes to the crew\'s own tools', schedules: 'background jobs and timing', external: 'acting outside the company', dashboard: 'pages in this console',
  packs: 'add-ons', deps: 'software the crew installs', org: 'how the team is organised',
  access: 'access and accounts', ownership: 'ownership', commitment: 'commitments', spendBeyondCap: 'spending beyond the cap' };
const FIXED_ALIAS = { commitments: 'commitment', spend_beyond_cap: 'spendBeyondCap', spendbeyondcap: 'spendBeyondCap' };
const EFFECTS = ['serviceApprove', 'harnessApply', 'none'];
const RULING_EFFECTS = ['crew-decides', 'never-ask', 'ask'];

function make(deps) {
  const { co } = deps;
  const TOOLS = co.p('company', 'tools');
  const gov = () => require(path.join(TOOLS, 'lib', 'governance.js'));
  const scope = () => require(path.join(TOOLS, 'lib', 'owner-scope.js'));
  const R = () => require(path.join(TOOLS, 'lib', 'owner-rulings.js'));
  const DIGEST = () => co.p('company', 'owner', 'digest.jsonl');
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };

  const govDoc = () => { try { return gov().doc() || {}; } catch (_) { return {}; } };
  const fixedSet = () => Object.keys(govDoc().fixed || {});
  const normFixed = c => { if (!c) return null; const s = String(c); const a = FIXED_ALIAS[s] || FIXED_ALIAS[s.toLowerCase()] || s; return fixedSet().includes(a) ? a : null; };
  const levelOf = c => { try { return gov().level(c); } catch (_) { return 'approve'; } };
  const catSay = c => CAT_SAY[c] || String(c || 'this kind of decision').replace(/[-_]/g, ' ');

  /* ---------- rulings ---------- */
  function rulings() { try { return R().list(); } catch (_) { return []; } }
  function ownerPathOrThrow(bad) {
    let ok = false; try { ok = require(path.join(TOOLS, 'lib', 'owner.js')).shell(); } catch (_) {}
    if (!ok) bad('only the owner makes a standing rule, from the console', 403);
  }
  function addRuling(o, bad) {
    ownerPathOrThrow(bad);
    const text = String((o && o.text) || '').replace(/\s+/g, ' ').trim();
    if (text.length < 3) bad('say the rule in a few words');
    if (text.length > 500) bad('keep the rule under 500 characters');
    const effect = RULING_EFFECTS.includes(o && o.effect) ? o.effect : 'crew-decides';
    const sc = (o && o.scope) || {};
    const cats = [...new Set((Array.isArray(sc.categories) ? sc.categories : []).map(String).filter(Boolean))];
    const topics = [...new Set((Array.isArray(sc.topics) ? sc.topics : []).map(t => String(t).trim().slice(0, 60)).filter(t => t.length >= 3))];
    if (!cats.length && !topics.length) bad('a rule needs what it covers (a kind of decision or a topic)');
    const known = Object.keys(govDoc().categories || {});
    for (const c of cats) {
      if (normFixed(c)) bad(catSay(normFixed(c)) + ' is one of the four decisions that are always yours, so no standing rule can cover it');
      if (!known.includes(c)) bad('unknown kind of decision: ' + c);
    }
    const res = R().add({ by: 'owner', text, effect, scope: Object.assign({}, cats.length ? { categories: cats } : {}, topics.length ? { topics } : {}), from: o && o.fromCard ? 'card ' + String(o.fromCard).slice(0, 20) : undefined });
    if (!res || !res.ok) bad((res && res.error) || 'the standing rule was not saved', res && res.code === 3 ? 403 : 400);
    return res.ruling;
  }
  function removeRuling(id, bad) {
    ownerPathOrThrow(bad);
    const res = R().remove({ by: 'owner', id });
    if (!res || !res.ok) bad((res && res.error) || 'no standing rule ' + id, res && res.code === 3 ? 403 : 404);
    return { ok: true, removed: id };
  }
  // the newest ruling covering a card: lib/owner-rulings.js match (the matcher lib/owner-card.js uses before filing)
  function rulingFor(card, list) {
    try { return R().match({ category: card.category, about: card.about, text: card.lead, ref: card.ref }, { rulings: list || rulings() }); } catch (_) { return null; }
  }

  /* ---------- needs you, or the crew is handling it ---------- */
  function categoryOf(q, row) {
    row = row || {};
    const g = row.gate || q.gate || {}; const ap = row.approval || q.approval || {};
    let c = g.category || ap.category || null;
    if (!c) { const m = /^(?:governance|approval):([A-Za-z]+)/.exec(String(q.about || row.about || '')); if (m) c = m[1]; }
    return c && c !== 'gate' ? c : null;
  }
  const asksKey = q => ['secret', 'account', 'link'].includes(q.kind) || !!(q.form && (q.form.fields || []).some(f => f.type === 'secret')) ||
    !!(q.questions || []).some(p => p.kind === 'secret' || (p.form && (p.form.fields || []).some(f => f.type === 'secret')));
  function classify(q, row, list) {
    row = row || {};
    const category = categoryOf(q, row);
    const flag = (row.gate && row.gate.fixedGate) || (q.gate && q.gate.fixedGate);
    const fixedGate = normFixed(typeof flag === 'string' ? flag : null) || normFixed(category) || (flag === true || row.fixedGate === true ? 'gate' : null);
    const lead = String(q.message || '').trim();
    if (fixedGate) return { needsOwner: true, why: 'fixed-gate', fixedGate, category: category || fixedGate };
    const ruling = rulingFor({ category, about: q.about, lead, ref: (row.gate && row.gate.ref) || (q.gate && q.gate.ref) || null }, list);
    if (ruling && ruling.effect === 'ask') return { needsOwner: true, why: 'ruling-ask', category, ruling: { id: ruling.id, text: ruling.text } };
    if (ruling) return { needsOwner: false, why: 'ruling', category, ruling: { id: ruling.id, text: ruling.text, effect: ruling.effect } };
    if (category) {
      const level = levelOf(category);
      return level === 'approve' || level === 'triage' ? { needsOwner: true, why: 'level', category, level } : { needsOwner: false, why: 'level', category, level };
    }
    if (asksKey(q)) return { needsOwner: true, why: 'access', category: null };
    let cls = null; try { cls = scope().classify({ message: lead || q.q, details: q.details, about: q.about }); } catch (_) {}
    if (cls && cls.scope === 'crew') return { needsOwner: false, why: 'crew-scope', category: null };
    return { needsOwner: true, why: 'owner-scope', category: null };
  }
  // a plain lead for a read-only line: the card's own first sentence when it reads plainly, else what it is about
  function plainLead(q, category) {
    const s = String(q.message || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/)[0] || '';
    let ok = false; try { const sc = scope().plainScore(s); ok = !sc.jargon.length && s.length <= 200; } catch (_) {}
    if (ok && s) return s;
    return category ? 'A question about ' + catSay(category) + '.' : 'A technical question for the crew.';
  }
  function handlingLine(c) {
    if (c.why === 'ruling') return 'You made a standing rule: “' + c.ruling.text + '”.';
    if (c.why === 'level') return 'Your settings let the crew decide ' + catSay(c.category) + (c.level === 'notify' ? ' and tell you afterwards.' : '.');
    return 'This is the crew\'s job, not yours: they sort it out themselves.';
  }
  /* split(questions, rowsById) -> { needs: [q + {needsOwner}], handling: [{id, from, askerSeat, lead, line, category, level?, ruling?}] } */
  function split(qs, rowsById) {
    const list = rulings(); const needs = [], handling = [];
    for (const q of qs) {
      const c = classify(q, (rowsById || {})[q.id], list);
      const tagged = Object.assign({}, q, { needsOwner: c.needsOwner, needsWhy: c.why });
      if (c.needsOwner) { needs.push(tagged); continue; }
      handling.push({ id: q.id, from: q.from, askerSeat: q.askerSeat || null, askedAt: q.askedAt, category: c.category, level: c.level || null, ruling: c.ruling || null,
        lead: plainLead(q, c.category), line: handlingLine(c), question: tagged });
    }
    return { needs, handling };
  }

  /* ---------- typed effects ---------- */
  function effectKind(e) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
    const keys = Object.keys(e).filter(k => e[k] !== undefined && e[k] !== null && e[k] !== false);
    return keys.length === 1 && EFFECTS.includes(keys[0]) ? keys[0] : null;
  }
  // the parameters of an effect in plain words: the crew's change by number and what it is about; the background job
  // by its name and when it runs (read from the owning tool's own record, never from the card)
  function changeWords(id) {
    const n = String(id || '').replace(/^hc-0*/, '') || String(id);
    const rec = /^hc-\d{1,6}$/.test(String(id)) ? readJson(co.p('company', 'work', 'changes', String(id) + '.json'), null) : null;
    let area = null; try { area = rec ? require(path.join(TOOLS, 'harness-change.js')).plainArea(rec) : null; } catch (_) { area = null; }
    return 'the crew\'s change number ' + n + (area ? ' (to ' + area + ')' : '') + (rec && rec.by ? ', proposed by ' + rec.by : '');
  }
  function jobWords(name) {
    const nm = String(name || '').replace(/[^a-z0-9-]/g, '');
    const e = ((readJson(co.p('company', 'state', 'services.json'), {}) || {}).services || {})[nm] || null;
    let when = null; try { when = e ? (e.kind === 'timer' ? 'runs ' + require(path.join(TOOLS, 'service.js')).plainWhen(e.schedule) : 'keeps running') : null; } catch (_) { when = null; }
    return 'the background job called “' + nm + '”' + (when ? ', which ' + when : '') + (e && e.byName ? ', asked for by ' + e.byName : '');
  }
  /* what yes does, in the console's own words (never the asker's), naming every parameter */
  function describeEffect(e) {
    const k = effectKind(e); if (!k) return e ? 'If you say yes, your answer is recorded; the console cannot apply this kind of change itself, so nothing changes automatically.' : null;
    const v = e[k] || {};
    switch (k) {
      case 'serviceApprove': return 'If you say yes, ' + jobWords(v.name) + ' is set up and started now, exactly as described.';
      case 'harnessApply': return 'If you say yes, ' + changeWords(v.id) + ' is made now, exactly as described. It is checked again after three days.';
      case 'none': return null;
    }
    return null;
  }
  /* cardDigest(row) -> a hash of the card as the owner sees it: from, words, technical part, effect and what yes does */
  function cardDigest(row) {
    const r = row || {};
    const shown = [r.from || '', r.message || '', r.consequence || '', r.recommendation || '', r.technical || '', JSON.stringify(r.effect || null), describeEffect(r.effect) || ''];
    return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(shown)).digest('hex');
  }
  const plainErr = m => String(m || 'it did not work').split('\n')[0].replace(/\s+/g, ' ').slice(0, 300);
  /* applyEffect(effect, {runApi, owner, id, card}) -> {kind, applied, said, technical?} */
  async function applyEffect(e, ctx) {
    const k = effectKind(e);
    if (!k) return { kind: null, applied: false, said: 'Your answer is recorded. Nothing was changed automatically: the console does not know how to apply this request, so nothing changes until the crew asks again.' };
    const v = e[k] || {};
    const fail = (err, what) => ({ kind: k, applied: false, said: 'Your answer is recorded, but ' + what + ' did not go through, so nothing changed. The crew has been told why.', technical: plainErr(err && err.message ? err.message : err) });
    const S = s => { const t = String(s == null ? '' : s).trim(); if (!t || t.startsWith('-')) throw new Error('bad value: ' + JSON.stringify(s)); return t; };
    try {
      if (k === 'none') return { kind: k, applied: false, said: 'Your answer is recorded.' };
      if (k === 'harnessApply') {
        // harness-change.js owner-apply acts only on the owner's recorded yes to this change's own card (just written)
        const r = await ctx.runApi('harness-change.js', ['owner-apply', S(v.id)], { timeout: 180000 });
        if (r && r.already) return { kind: k, applied: false, said: 'Your answer is recorded. That change was already settled, so nothing more changed.' };
        if (!r || !(r.applied || r.upstream)) return fail(new Error((r && (r.note || r.status)) || 'not applied'), 'making the change');
        return { kind: k, applied: true, said: r.upstream ? 'Done: the improvement goes to the makers of the company software, who review it before any company gets it.' : 'Done: the crew\'s change is made. It is checked again in three days.' };
      }
      if (k === 'serviceApprove') {
        // service.js owner-approve installs only the exact spec the owner's card was about, on the owner's recorded yes
        const r = await ctx.runApi('service.js', ['owner-approve', S(v.name)], { timeout: 120000 });
        if (r && r.already) return { kind: k, applied: false, said: 'It was already running, so nothing changed.' };
        if (!r || !r.installed) return fail(new Error((r && (r.text || r.error)) || 'not installed'), 'starting the job');
        return { kind: k, applied: true, said: 'Done: the background job is set up and running.' };
      }
    } catch (err) { return fail(err, { harnessApply: 'making the change', serviceApprove: 'starting the job' }[k] || 'the change'); }
    return { kind: k, applied: false, said: 'Your answer is recorded.' };
  }

  /* ---------- the digest ---------- */
  function digest(o) {
    o = o || {};
    const since = Date.now() - (o.hours || 24) * 3600e3;
    let lines = []; try { lines = require(path.join(TOOLS, 'lib', 'bounded.js')).tailLines(DIGEST(), 400); } catch (_) {}
    const byKey = new Map(); let n = 0;
    for (const l of lines) {
      let r; try { r = JSON.parse(l); } catch (_) { continue; }
      if (!r || r._retention || (r.kind && r.kind !== 'fyi') || typeof r.text !== 'string' || !r.text.trim()) continue;
      const at = Date.parse(r.at || ''); if (!Number.isFinite(at) || at < since) continue;
      byKey.set(r.key ? 'k:' + r.key : 'n:' + (n++), { at: new Date(at).toISOString(), from: r.from || null, text: String(r.text).slice(0, 600), technical: r.technical ? String(r.technical).slice(0, 4000) : null });
    }
    const items = [...byKey.values()].sort((a, b) => a.at.localeCompare(b.at));
    return { ok: true, title: 'What the crew did today', items, since: new Date(since).toISOString() };
  }

  return { classify, split, rulings, addRuling, removeRuling, rulingFor, effectKind, describeEffect, cardDigest, applyEffect, digest, plainLead, LEVEL_SAY, CAT_SAY, catSay };
}
module.exports = { make, LEVEL_SAY, CAT_SAY, EFFECTS, RULING_EFFECTS };
