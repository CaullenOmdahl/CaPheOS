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
 * Written only here (the console is an owner path) or by an owner CLI under lib/owner.js; the bytes are recorded in the
 * provenance log (writer "console (owner ruling)"). The fixed gates always override a ruling, and a ruling cannot name one.
 *
 * TYPED EFFECTS (applyEffect): a card may carry `effect`, applied only here, only after the owner's own yes:
 *   {governance:{category, level}}  governance.js set                     {clearance:{category, target, agent?, until, why, acts?, ownAct?}}
 *   {projectApprove:{id}}           project.js approve                     external-gate.js clear (a justification file is written)
 *   {serviceApprove:{name}}         service.js propose (the stored spec)   {harnessApply:{id}}  harness-change.js approve + apply
 *   {moduleEnable:{id}}             module.js enable                       {lockedAccept:{path}} locked-watch.js accept
 *   {budgetToday:{usd}}             money-hold.js set raise                {none:true}          nothing
 * Each runs the owner's own tool with --by <owner> from this process, so the tool's owner check and its own record apply.
 * The card shows what yes does in the console's own words (describeEffect), never the asker's. An unknown effect: the
 * answer is recorded, nothing is applied, and the owner is told so.
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
const EFFECTS = ['governance', 'clearance', 'projectApprove', 'serviceApprove', 'harnessApply', 'moduleEnable', 'lockedAccept', 'budgetToday', 'none'];
const RULING_EFFECTS = ['crew-decides', 'never-ask', 'ask'];

function make(deps) {
  const { co } = deps;
  const TOOLS = co.p('company', 'tools');
  const gov = () => require(path.join(TOOLS, 'lib', 'governance.js'));
  const scope = () => require(path.join(TOOLS, 'lib', 'owner-scope.js'));
  const RULINGS = () => co.p('company', 'state', 'owner-rulings.json');
  const DIGEST = () => co.p('company', 'owner', 'digest.jsonl');
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };

  const govDoc = () => { try { return gov().doc() || {}; } catch (_) { return {}; } };
  const fixedSet = () => Object.keys(govDoc().fixed || {});
  const normFixed = c => { if (!c) return null; const s = String(c); const a = FIXED_ALIAS[s] || FIXED_ALIAS[s.toLowerCase()] || s; return fixedSet().includes(a) ? a : null; };
  const levelOf = c => { try { return gov().level(c); } catch (_) { return 'approve'; } };
  const catSay = c => CAT_SAY[c] || String(c || 'this kind of decision').replace(/[-_]/g, ' ');

  /* ---------- rulings ---------- */
  function rulings() {
    const d = readJson(RULINGS(), null);
    return d && Array.isArray(d.rulings) ? d.rulings.filter(r => r && r.id && RULING_EFFECTS.includes(r.effect) && r.by === 'owner') : [];
  }
  function writeRulings(list) {
    const f = RULINGS(); fs.mkdirSync(path.dirname(f), { recursive: true });
    const text = JSON.stringify({ _doc: 'Standing owner rulings (console/owner-needs.js). Written only from an owner path: the console\'s "Make this a standing rule", Settings › Autonomy › Standing rules. The fixed owner gates always override a ruling.', rulings: list }, null, 1) + '\n';
    const tmp = f + '.tmp-' + process.pid; fs.writeFileSync(tmp, text); fs.renameSync(tmp, f);
    try { require(path.join(TOOLS, 'provenance.js')).wrote(f, text, 'console (owner ruling)'); } catch (_) {}
    return text;
  }
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
    const r = { id: 'rule-' + Date.now().toString(36) + '-' + crypto.randomBytes(2).toString('hex'), at: new Date().toISOString(), by: 'owner', text,
      scope: Object.assign({}, cats.length ? { categories: cats } : {}, topics.length ? { topics } : {}), effect };
    if (o && o.fromCard) r.fromCard = String(o.fromCard).slice(0, 20);
    writeRulings(rulings().concat([r]));
    return r;
  }
  function removeRuling(id, bad) {
    ownerPathOrThrow(bad);
    const all = rulings(); const left = all.filter(r => r.id !== id);
    if (left.length === all.length) bad('no standing rule ' + id, 404);
    writeRulings(left);
    return { ok: true, removed: id };
  }
  const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function rulingFor(card, list) {
    const about = String(card.about || '').toLowerCase(); const text = about + ' ' + String(card.lead || '').toLowerCase();
    for (const r of (list || rulings()).slice().reverse()) {
      const cats = (r.scope && r.scope.categories) || [], topics = (r.scope && r.scope.topics) || [];
      if (card.category && cats.includes(card.category)) return r;
      for (const t of topics) { const tl = String(t).toLowerCase(); if (about === tl || new RegExp('(^|\\W)' + esc(tl) + '(\\W|$)', 'i').test(text)) return r; }
    }
    return null;
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
    const ruling = rulingFor({ category, about: q.about, lead }, list);
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
  const money = n => '$' + (Math.round(Number(n) * 100) / 100).toFixed(Number(n) % 1 ? 2 : 0);
  function moduleTitle(id) { const m = readJson(co.p('modules', String(id).replace(/[^a-z0-9-]/g, ''), 'module.json'), null); return (m && (m.title || m.name)) || String(id).replace(/-/g, ' '); }
  function projectName(id) { const d = readJson(co.p('company', 'projects.json'), null); const p = d && (d.projects || []).find(x => x.id === String(id).toLowerCase()); return (p && p.name) || String(id); }
  const dayOf = iso => { try { return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: process.env.CAPHEOS_TZ || co.config.timezone || co.TZ || undefined }).format(new Date(iso)); } catch (_) { return String(iso).slice(0, 10); } };
  /* what yes does, in the console's own words (never the asker's) */
  function describeEffect(e) {
    const k = effectKind(e); if (!k) return e ? 'If you say yes, your answer is recorded; the console cannot apply this kind of change itself, so the crew does it.' : null;
    const v = e[k] || {};
    switch (k) {
      case 'governance': return LEVEL_SAY[v.level] ? 'If you say yes, your setting for ' + catSay(v.category) + ' becomes “' + LEVEL_SAY[v.level] + '”. You can change it back in Settings › Autonomy.' : null;
      case 'clearance': return 'If you say yes, the crew may do this one outside action' + (v.until ? ' until ' + dayOf(v.until) : '') + '.';
      case 'projectApprove': return 'If you say yes, the crew may take over the project “' + projectName(v.id) + '”.';
      case 'serviceApprove': return 'If you say yes, the background job the crew asked for is started now.';
      case 'harnessApply': return 'If you say yes, the change the crew proposed to its own tools is made now. It is checked again after three days.';
      case 'moduleEnable': return 'If you say yes, the add-on “' + moduleTitle(v.id) + '” is switched on now.';
      case 'lockedAccept': return 'If you say yes, a change to one of the crew\'s protected files is kept as the accepted version.';
      case 'budgetToday': return Number(v.usd) >= 0 ? 'If you say yes, today\'s spending limit becomes ' + money(v.usd) + ', for today only.' : null;
      case 'none': return null;
    }
    return null;
  }
  const plainErr = m => String(m || 'it did not work').split('\n')[0].replace(/\s+/g, ' ').slice(0, 300);
  /* applyEffect(effect, {runApi, owner, id, card}) -> {kind, applied, said, technical?} */
  async function applyEffect(e, ctx) {
    const k = effectKind(e);
    if (!k) return { kind: null, applied: false, said: 'Your answer is recorded. Nothing was changed automatically: the console does not know how to apply this request, so the crew carries it out.' };
    const v = e[k] || {}; const by = ctx.owner();
    const fail = (err, what) => ({ kind: k, applied: false, said: 'Your answer is recorded, but ' + what + ' did not go through, so nothing changed. The crew has been told why.', technical: plainErr(err && err.message ? err.message : err) });
    const S = s => { const t = String(s == null ? '' : s).trim(); if (!t || t.startsWith('-')) throw new Error('bad value: ' + JSON.stringify(s)); return t; };
    try {
      if (k === 'none') return { kind: k, applied: false, said: 'Your answer is recorded.' };
      if (k === 'governance') {
        if (normFixed(v.category)) return { kind: k, applied: false, said: 'Your answer is recorded. ' + catSay(normFixed(v.category)).replace(/^./, c => c.toUpperCase()) + ' is one of the four decisions that are always yours, so that setting was not changed.' };
        if (!LEVEL_SAY[v.level]) return fail(new Error('unknown level ' + v.level), 'the setting change');
        const r = await ctx.runApi('governance.js', ['set', S(v.category), S(v.level), '--by', by]);
        return { kind: k, applied: true, said: r && r.unchanged ? 'Your setting for ' + catSay(v.category) + ' was already “' + LEVEL_SAY[v.level] + '”, so nothing changed.' : 'Done: your setting for ' + catSay(v.category) + ' is now “' + LEVEL_SAY[v.level] + '”.' };
      }
      if (k === 'projectApprove') { await ctx.runApi('project.js', ['approve', '--id', S(v.id), '--by', by]); return { kind: k, applied: true, said: 'Done: the crew may now take over “' + projectName(v.id) + '”.' }; }
      if (k === 'moduleEnable') { await ctx.runApi('module.js', ['enable', S(v.id), '--by', by, '--json'], { timeout: 180000 }); return { kind: k, applied: true, said: 'Done: “' + moduleTitle(v.id) + '” is switched on.' }; }
      if (k === 'lockedAccept') {
        await ctx.runApi('locked-watch.js', ['accept', S(v.path), '--by', by, '--why', 'accepted by the owner on Today (' + (ctx.id || 'a card') + ')']);
        return { kind: k, applied: true, said: 'Done: the change is kept as the accepted version.' };
      }
      if (k === 'budgetToday') {
        const usd = Number(v.usd); if (!(usd >= 0 && usd <= 100000)) return fail(new Error('bad amount ' + v.usd), 'the budget change');
        await ctx.runApi('money-hold.js', ['set', 'raise', '--budget', String(usd), '--by', by, '--why', 'raised by the owner on Today (' + (ctx.id || 'a card') + ')']);
        return { kind: k, applied: true, said: 'Done: today\'s spending limit is ' + money(usd) + '. It goes back to normal tomorrow.' };
      }
      if (k === 'harnessApply') {
        const id = S(v.id);
        try { await ctx.runApi('harness-change.js', ['approve', id, '--by', by, '--note', 'approved by the owner on Today']); } catch (err) { if (!/already|approved/i.test(String(err.message))) throw err; }
        await ctx.runApi('harness-change.js', ['apply', id, '--by', by], { timeout: 180000 });
        return { kind: k, applied: true, said: 'Done: the crew\'s change is made. It is checked again in three days.' };
      }
      if (k === 'serviceApprove') {
        const name = S(v.name); const svc = require(path.join(TOOLS, 'service.js'));
        const sctx = svc.context(); const rec = (readJson(co.p('company', 'state', 'services.json'), {}).services || {})[name];
        if (!rec) return fail(new Error('no registered service ' + name), 'starting the job');
        if (rec.status === 'installed') return { kind: k, applied: false, said: 'It was already running, so nothing changed.' };
        const o = { kind: rec.kind, argv: rec.argv, why: rec.why, restart: rec.restart, 'soft-halt': rec.softHalt, by };
        if (rec.network === false) o.network = 'none';
        if (rec.timeout) o.timeout = rec.timeout + 's';
        if (rec.successExit) o['success-exit'] = rec.successExit;
        if (rec.limits) { o.memory = rec.limits.memoryMax; o.cpu = rec.limits.cpuQuota; }
        if (rec.schedule && rec.schedule.every) o.every = rec.schedule.every + 's';
        if (rec.schedule && rec.schedule.onCalendar) o['on-calendar'] = rec.schedule.onCalendar;
        if (rec.wake && rec.wake.length) o.wake = rec.wake.join(',');
        const r = svc.propose(sctx, name, o);
        if (r && r.ok === false) return fail(new Error(r.error || 'not installed'), 'starting the job');
        return { kind: k, applied: true, said: 'Done: the background job is set up and running.' };
      }
      if (k === 'clearance') {
        const cat = S(v.category), target = S(v.target);
        const until = v.until && Number.isFinite(Date.parse(v.until)) ? new Date(v.until).toISOString() : new Date(Date.now() + 7 * 864e5).toISOString();
        const rel = path.join('company', 'work', 'owner-answers', String(ctx.id || 'card').replace(/[^A-Za-z0-9-]/g, '') + '-clearance.md');
        const abs = co.p(rel); fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, '# Owner clearance (' + (ctx.id || 'a card') + ')\n\nThe owner said yes on Today to: ' + String((ctx.card && ctx.card.message) || '').replace(/\s+/g, ' ').slice(0, 600) + '\n\n- category: ' + cat + '\n- target: ' + target + '\n- until: ' + until + '\n- why: ' + String(v.why || '').replace(/\s+/g, ' ').slice(0, 400) + '\n');
        const args = ['clear', '--by', by, '--category', cat, '--target', target, '--until', until, '--justification', rel.split(path.sep).join('/'), '--note', ('owner yes on Today ' + (ctx.id || '')).trim()];
        if (v.agent) args.push('--agent', S(v.agent));
        if (Array.isArray(v.acts) && v.acts.length) args.push('--acts', v.acts.map(S).join(','));
        if (v.ownAct) args.push('--own-act', S(v.ownAct));
        await ctx.runApi('external-gate.js', args);
        return { kind: k, applied: true, said: 'Done: the crew may do this' + ' until ' + dayOf(until) + '.' };
      }
    } catch (err) { return fail(err, { governance: 'the setting change', projectApprove: 'the project approval', moduleEnable: 'switching on the add-on', lockedAccept: 'keeping the change', budgetToday: 'the budget change', harnessApply: 'making the change', serviceApprove: 'starting the job', clearance: 'the clearance' }[k] || 'the change'); }
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

  return { classify, split, rulings, addRuling, removeRuling, rulingFor, effectKind, describeEffect, applyEffect, digest, plainLead, LEVEL_SAY, CAT_SAY, catSay };
}
module.exports = { make, LEVEL_SAY, CAT_SAY, EFFECTS, RULING_EFFECTS };
