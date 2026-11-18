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
 *   - a guardrail requires the owner's yes (row.gate.guardrail: lib/owner-card.js), and no ruling ever hides one; or
 *   - it asks for a key or an account (access), or it is the money hold's question (money needed now: about
 *     money-hold:*): no ruling ever hides either, whatever its category; or
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
 *   {packInstall:{id,digest}} pack.js approve --digest + install (filed only by pack.js)
 *   {moduleEnable:{id}}      module.js enable (filed only by module.js)
 *   {lockedAccept:{key,sha}} locked-watch.js accept --expect-sha (filed only by locked-watch.js)
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
  packs: 'add-ons', deps: 'software the crew installs', org: 'how the team is organised', localComputer: 'background jobs on this computer',
  access: 'access and accounts', ownership: 'ownership', commitment: 'commitments', spendBeyondCap: 'spending beyond the cap' };
const FIXED_ALIAS = { commitments: 'commitment', spend_beyond_cap: 'spendBeyondCap', spendbeyondcap: 'spendBeyondCap' };
const EFFECTS = ['serviceApprove', 'harnessApply', 'packInstall', 'moduleEnable', 'lockedAccept', 'none'];
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
      // never the internal name of the kind: the owner reads what it is about
      if (!known.includes(c)) bad(CAT_SAY[c] ? 'Questions about ' + catSay(c) + ' cannot be covered by a standing rule.' : 'This kind of question cannot be covered by a standing rule.');
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
    // never behind a ruling or a level: a guardrail's ask, a key or account request, money needed now
    if ((row.gate && row.gate.guardrail) || (q.gate && q.gate.guardrail)) return { needsOwner: true, why: 'guardrail', category };
    // an act only the owner may do (install an add-on, switch one on, keep a protected file's change: lib/owner-card.js ownerAct)
    if ((row.gate && row.gate.ownerAct) || (q.gate && q.gate.ownerAct)) return { needsOwner: true, why: 'owner-act', category };
    if (asksKey(q) || asksKey(row)) return { needsOwner: true, why: 'access', category };
    if (/^money-hold:/.test(String(q.about || row.about || ''))) return { needsOwner: true, why: 'money-now', category };
    const ruling = rulingFor({ category, about: q.about, lead, ref: (row.gate && row.gate.ref) || (q.gate && q.gate.ref) || null }, list);
    if (ruling && ruling.effect === 'ask') return { needsOwner: true, why: 'ruling-ask', category, ruling: { id: ruling.id, text: ruling.text } };
    if (ruling) return { needsOwner: false, why: 'ruling', category, ruling: { id: ruling.id, text: ruling.text, effect: ruling.effect } };
    if (category) {
      const level = levelOf(category);
      return level === 'approve' || level === 'triage' ? { needsOwner: true, why: 'level', category, level } : { needsOwner: false, why: 'level', category, level };
    }
    let cls = null; try { cls = scope().classify({ message: lead || q.q, details: q.details, about: q.about }); } catch (_) {}
    if (cls && cls.scope === 'crew') return { needsOwner: false, why: 'crew-scope', category: null };
    return { needsOwner: true, why: 'owner-scope', category: null };
  }
  /* ruleOffer(q, row) -> {ok: true, scope} | {ok: false, why}: may "Make this a standing rule" be offered on this card,
   * and what the rule would cover. Never where no rule can work: one of the four fixed gates, a guardrail's card (the
   * safety setting asks, not the governance level), a key or account request, or the money hold's question (money
   * needed now: lib/money-hold.js keeps the crew paused until the owner answers, whatever a rule says). Otherwise the
   * card's governance category (one the owner's settings know), or its topic. */
  function ruleOffer(q, row, list) {
    row = row || {};
    const c = classify(q, row, list || []);
    if (c.fixedGate) return { ok: false, why: 'This is one of the four decisions that are always yours, so it cannot become a standing rule.' };
    if (c.why === 'guardrail') return { ok: false, why: 'This one always comes to you while the safety setting for it is on (Settings › Autonomy › Guardrails), so a standing rule cannot cover it.' };
    if (c.why === 'access') return { ok: false, why: 'A key or an account in your name always needs you, so it cannot become a standing rule.' };
    if (c.why === 'owner-act') return { ok: false, why: 'Only you can do this, so a standing rule cannot cover it.' };
    if (c.why === 'money-now' || /^money-hold:/.test(String(q.about || row.about || ''))) return { ok: false, why: 'The crew stays paused until you choose on this card, so a standing rule cannot answer it.' };
    if (q.questions) return { ok: false, why: 'A question with several parts cannot become one standing rule.' };
    const known = Object.keys(govDoc().categories || {});
    if (c.category) return known.includes(c.category) ? { ok: true, scope: { categories: [c.category] } } : { ok: false, why: CAT_SAY[c.category] ? 'Questions about ' + catSay(c.category) + ' cannot be covered by a standing rule.' : 'This kind of question cannot be covered by a standing rule.' };
    const topics = [String(q.about || '').trim()].filter(t => t.length >= 3 && !/^(governance|approval|card):/.test(t));
    return topics.length ? { ok: true, scope: { topics } } : { ok: false, why: 'This question has no kind or topic a rule could cover.' };
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
      const offer = ruleOffer(q, (rowsById || {})[q.id], list);
      const tagged = Object.assign({}, q, { needsOwner: c.needsOwner, needsWhy: c.why, canRule: offer.ok, ruleWhy: offer.ok ? null : offer.why });
      if (c.needsOwner) { needs.push(tagged); continue; }
      handling.push({ id: q.id, from: q.from, askerSeat: q.askerSeat || null, askedAt: q.askedAt, category: c.category, level: c.level || null, ruling: c.ruling || null,
        lead: plainLead(q, c.category), line: handlingLine(c), question: tagged });
    }
    return { needs, handling };
  }

  /* ---------- typed effects ---------- */
  // a kind the console applies, with the shape lib/owner-card.js accepts (a malformed effect is never applied)
  function effectKind(e) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
    const keys = Object.keys(e).filter(k => e[k] !== undefined && e[k] !== null && e[k] !== false);
    if (keys.length !== 1 || !EFFECTS.includes(keys[0])) return null;
    let shapes = null; try { shapes = require(path.join(TOOLS, 'lib', 'owner-card.js')).EFFECT_SHAPES; } catch (_) {}
    return !shapes || (shapes[keys[0]] && shapes[keys[0]](e[keys[0]])) ? keys[0] : null;
  }
  const plainT = t => String(t || '').replace(/[\u201c\u201d"]/g, '').slice(0, 60);
  function packWords(id) {
    const nm = String(id || '').replace(/[^a-z0-9-]/g, '');
    const p = readJson(co.p('company', 'state', 'packs', 'proposed', nm, 'pack.json'), null) || readJson(co.p('packs', nm, 'pack.json'), null);
    return 'the add-on “' + plainT((p && (p.title || p.name)) || nm.replace(/-/g, ' ')) + '”';
  }
  function moduleWords(id) {
    const nm = String(id || '').replace(/[^a-z0-9-]/g, '');
    const m = readJson(co.p('modules', nm, 'module.json'), null);
    let t = null; try { t = require(path.join(TOOLS, 'module.js')).plainTitle(nm, m); } catch (_) {}
    return t ? (/^“/.test(t) ? 'the add-on ' + t : t) : 'the add-on “' + plainT((m && (m.title || m.name)) || nm.replace(/-/g, ' ')) + '”';
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
      case 'packInstall': return 'If you say yes, ' + packWords(v.id) + ' is installed now, exactly as it was proposed. Its limits start closed.';
      case 'moduleEnable': return 'If you say yes, ' + moduleWords(v.id) + ' is switched on now. You can switch it off again in Settings › System.';
      case 'lockedAccept': return 'If you say yes, the change to that protected file is kept as it is now. If the file changes again before you answer, nothing is kept.';
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
      if (k === 'packInstall') {
        // approve (if the crew has not) and install exactly the proposed copy the card named (pack.js checks the digest)
        const st = await ctx.runApi('pack.js', ['status', S(v.id), '--json'], { timeout: 60000 }).catch(() => null);
        if (st && (st.installed || st.status === 'conformant')) return { kind: k, applied: false, said: 'It was already installed, so nothing changed.' };
        await ctx.runApi('pack.js', ['approve', S(v.id), '--by', ctx.owner(), '--digest', S(v.digest)], { timeout: 120000 }).catch(e => { if (!/already approved/.test(String(e && e.message))) throw e; });
        await ctx.runApi('pack.js', ['install', S(v.id), '--by', ctx.owner()], { timeout: 180000 });
        return { kind: k, applied: true, said: 'Done: ' + packWords(v.id) + ' is installed. Its limits start closed.' };
      }
      if (k === 'moduleEnable') {
        await ctx.runApi('module.js', ['enable', S(v.id), '--by', ctx.owner(), '--json'], { timeout: 180000 });
        return { kind: k, applied: true, said: 'Done: ' + moduleWords(v.id) + ' is switched on.' };
      }
      if (k === 'lockedAccept') {
        // kept only when the file is still exactly what the card described (locked-watch.js checks --expect-sha)
        await ctx.runApi('locked-watch.js', ['accept', S(v.key), '--by', ctx.owner(), '--why', 'kept by the owner on Today (' + (ctx.id || 'a card') + ')', '--expect-sha', S(v.sha)], { timeout: 60000 });
        return { kind: k, applied: true, said: 'Done: the change is kept as the accepted version.' };
      }
      if (k === 'serviceApprove') {
        // service.js owner-approve installs only the exact spec the owner's card was about, on the owner's recorded yes
        const r = await ctx.runApi('service.js', ['owner-approve', S(v.name)], { timeout: 120000 });
        if (r && r.already) return { kind: k, applied: false, said: 'It was already running, so nothing changed.' };
        if (!r || !r.installed) return fail(new Error((r && (r.text || r.error)) || 'not installed'), 'starting the job');
        return { kind: k, applied: true, said: 'Done: the background job is set up and running.' };
      }
    } catch (err) { return fail(err, { harnessApply: 'making the change', serviceApprove: 'starting the job', packInstall: 'installing the add-on', moduleEnable: 'switching the add-on on', lockedAccept: 'keeping the change' }[k] || 'the change'); }
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
      // a crew-only row (nothing plain to say: lib/owner-notice.js) is never a line on Today
      if (!r || r._retention || r.crewOnly || (r.kind && r.kind !== 'fyi') || typeof r.text !== 'string' || !r.text.trim()) continue;
      const at = Date.parse(r.at || ''); if (!Number.isFinite(at) || at < since) continue;
      const action = r.action && r.action.kind === 'undo-decision' && /^d-[0-9a-f]{12}$/.test(String(r.action.decisionId || '')) ? { kind: 'undo-decision', decisionId: r.action.decisionId, label: 'Undo this' } : null;
      byKey.set(r.key ? 'k:' + r.key : 'n:' + (n++), Object.assign({ at: new Date(at).toISOString(), from: r.from || null, text: String(r.text).slice(0, 600), technical: r.technical ? String(r.technical).slice(0, 4000) : null }, action ? { action } : {}, r.asks ? { asks: true } : {}));
    }
    const items = [...byKey.values()].sort((a, b) => a.at.localeCompare(b.at));
    return { ok: true, title: 'What the crew did today', items, since: new Date(since).toISOString() };
  }

  return { classify, split, ruleOffer, rulings, addRuling, removeRuling, rulingFor, effectKind, describeEffect, cardDigest, applyEffect, digest, plainLead, LEVEL_SAY, CAT_SAY, catSay };
}
module.exports = { make, LEVEL_SAY, CAT_SAY, EFFECTS, RULING_EFFECTS };
