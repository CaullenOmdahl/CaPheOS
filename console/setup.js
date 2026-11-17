/* console/setup.js — the owner's guided Setup (#/setup), server side. Spec: docs/CONSOLE-API.md "Setup".
 *
 * Seven steps, each computed from the files and the station as they stand (never from a wizard's own memory):
 *   company  · provider · budget · governance · charter · guardrails · certify
 * Every write acts as the owner, through the same files and tools the owner would use from a shell:
 *   company/company.json (name, owner, timezone), company/model-policy.json candidateDefault (+ allowed when a new
 *   provider is connected), company/work/finance/dispatch-budget.json (dailyUsd, perAgentUsd, unmeteredProviders),
 *   company/CHARTER.md (filled from its template). After a write to a tracked file in a founded checkout it reruns
 *   scripts/instance-guard.sh so the change never shows in git status. Locked files record the write with provenance.js so
 *   locked-watch.js accepts it; each change gets one line in company/work/decisions.md.
 * The onboarding gate onboard.js filed ("hiring candidates default to a metered model with a $0 cap") is answered
 * here once the company can actually run a candidate, and the candidate-default step is recorded ok.
 */
'use strict';
// a model id in plain words for the owner ("claude-haiku-4-5-20251001" -> "Claude Haiku 4.5"); the same rule as plain.js modelName
function plainModel(id, provider) {
  const B = { deepseek: 'DeepSeek', minimax: 'MiniMax', claude: 'Claude', gpt: 'GPT', gemini: 'Gemini' };
  let s = String(id || ''); if (s.includes('/')) s = s.slice(s.indexOf('/') + 1);
  const out = [];
  for (const w of s.split(/[-_\s]+/).filter(Boolean)) {
    if (/^\d{8}$/.test(w)) continue;   // a release date
    if (/^\d+$/.test(w) && out.length && /^\d+(\.\d+)*$/.test(out[out.length - 1])) { out[out.length - 1] += '.' + w; continue; }
    out.push(B[w.toLowerCase()] || (/^[a-z]\d/i.test(w) ? w.toUpperCase() : /^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)));
  }
  const name = out.join(' ');
  return name || String(provider || id || '');
}
const fs = require('fs');
const path = require('path');

module.exports = function setup(deps) {
  const { co, run, runApi, stationGet, stationPost, owner, setOwner, bad, HttpError, tool } = deps;
  const F = {
    company: co.p('company', 'company.json'),
    policy: co.p('company', 'model-policy.json'),
    budget: co.p('company', 'work', 'finance', 'dispatch-budget.json'),
    budgetDefault: co.p('company', 'defaults', 'work', 'finance', 'dispatch-budget.json'),
    charter: co.p('company', 'CHARTER.md'),
    gov: co.p('company', 'state', 'governance.json'),
    decisions: co.p('company', 'work', 'decisions.md'),
    onboarding: co.p('company', 'state', 'onboarding-state.json'),
  };
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
  const prov = () => { try { return require(path.join(co.ROOT, 'company', 'tools', 'provenance.js')); } catch (_) { return null; } };
  function writeFile(f, text) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const t = f + '.tmp-' + process.pid; fs.writeFileSync(t, text); fs.renameSync(t, f);
    const p = prov(); if (p) p.wrote(f, text, 'console setup (owner)');
    guardTracked(f);
  }
  // A tracked file the owner just changed (company.json, model-policy.json, CHARTER.md) must not show in git status of
  // a founded checkout: rerun scripts/instance-guard.sh, which hides it with skip-worktree (README "What founding does").
  function guardTracked(f) {
    try {
      const g = path.join(co.ROOT, 'scripts', 'instance-guard.sh');
      if (!fs.existsSync(g) || !fs.existsSync(co.p('company', 'work', '.founded'))) return;
      const cp = require('child_process');
      const r = cp.spawnSync('git', ['ls-files', '--', path.relative(co.ROOT, f)], { cwd: co.ROOT, encoding: 'utf8', timeout: 10000 });
      if (r.status !== 0 || !String(r.stdout).trim()) return;
      cp.execFileSync('bash', [g], { cwd: co.ROOT, stdio: 'ignore', timeout: 30000 });
    } catch (_) {}
  }
  const writeJson = (f, v) => writeFile(f, JSON.stringify(v, null, 2) + '\n');
  function decision(text) {
    try {
      if (!fs.existsSync(F.decisions)) { fs.mkdirSync(path.dirname(F.decisions), { recursive: true }); fs.appendFileSync(F.decisions, '# Decisions\n\n'); }
      const lp = co.localParts(new Date());
      const line = '- ' + lp.date + ' ' + lp.time + ' ' + owner() + ' (owner) ' + text + ' (console Setup)\n';
      fs.appendFileSync(F.decisions, line);
      const p = prov(); if (p) p.appended(F.decisions, line, 'console setup (owner)');
    } catch (_) {}
  }

  /* ---------- providers the Setup screen offers ---------- */
  // id = the station provider id. unmetered = billed by subscription (never counts against dailyUsd).
  const OFFER = [
    { id: 'claude-cli', name: 'Claude subscription', how: 'signin', unmetered: true, blurb: 'Your Claude Pro or Max plan, through Claude Code on this machine. Flat fee: nothing is billed per token.' },
    { id: 'custom', name: 'MiniMax Coding Plan', how: 'key', unmetered: true, /* baseUrl, keyUrl: offerNow() from company.json providers.minimax */ blurb: 'A MiniMax plan key. Flat fee, paced against the plan.' },
    { id: 'deepseek', name: 'DeepSeek', how: 'key', unmetered: false, keyUrl: 'https://platform.deepseek.com/api_keys', blurb: 'Pay per token from a prepaid balance. Needs a daily cap in step 3.' },
    { id: 'openrouter', name: 'OpenRouter', how: 'key', unmetered: false, keyUrl: 'https://openrouter.ai/keys', blurb: 'One key for many models, pay per token. Needs a daily cap in step 3.' },
    { id: 'anthropic', name: 'Anthropic API', how: 'key', unmetered: false, keyUrl: 'https://console.anthropic.com/settings/keys', blurb: 'Claude by API key, pay per token. Needs a daily cap in step 3.' },
  ];
  const FALLBACK_MODEL = { anthropic: 'claude-haiku-4-5', openrouter: 'deepseek/deepseek-chat' };
  const offerOf = id => OFFER.find(o => o.id === id);

  /* ---------- the MiniMax endpoint (company.json providers.minimax; company/tools/lib/minimax-endpoint.js) ---------- */
  const MME = require(path.join(__dirname, '..', 'company', 'tools', 'lib', 'minimax-endpoint.js'));
  const mmNow = () => MME.read(co.ROOT);
  // the endpoint a request asks for ({region, baseUrl?, other?}), or the stored one when it names none
  function mmWanted(b) {
    if (!b || (b.region === undefined && b.baseUrl === undefined)) return { ep: mmNow(), explicit: false };
    const ep = MME.resolve({ region: b.region || 'custom', baseUrl: b.baseUrl, other: b.other === true });
    if (!ep.ok) throw new HttpError(400, ep.error, { code: ep.code || 'bad-endpoint' });
    return { ep, explicit: true };
  }
  const mmView = ep => ({ region: ep.region, label: ep.label, plain: MME.plain(ep), custom: ep.custom, other: !!ep.other, baseUrl: ep.baseUrl, keyUrl: ep.keyUrl,
    usageUrl: ep.usageUrl, warnings: ep.warnings || [], problem: ep.problem || null, stored: !!ep.stored, choices: MME.choices() });
  // the offer as the owner sees it: MiniMax's address and key page follow the stored endpoint
  function offerNow(o) { if (o.id !== 'custom') return o; const ep = mmNow(); return Object.assign({}, o, { baseUrl: ep.baseUrl, keyUrl: ep.keyUrl, endpoint: mmView(ep) }); }
  function saveEndpoint(ep, prev) {
    const cfg = readJson(F.company, null); if (!cfg) bad('company/company.json is missing or not JSON', 500);
    cfg.providers = Object.assign({}, cfg.providers || {}, { minimax: MME.entryOf(ep, owner()) });
    writeJson(F.company, cfg);
    co.config.providers = cfg.providers;
    decision('set the MiniMax endpoint to ' + MME.plain(ep) + (ep.custom ? ' (' + ep.baseUrl + ')' : '') + (prev && prev.stored ? ', was ' + MME.plain(prev) : '') + ' (company.json providers.minimax)');
  }
  const scrubKey = (s, key) => String(s == null ? '' : s).split(key || '\u0000').join('[key]').slice(0, 160);

  function budget() { return Object.assign({}, readJson(F.budgetDefault, {}), readJson(F.budget, {}) || {}); }
  function unmeteredList(b) { return (Array.isArray(b.unmeteredProviders) && b.unmeteredProviders.length ? b.unmeteredProviders : ['claude-cli']).map(String); }

  async function stationProviders() {
    const r = await stationGet('providers', 3000);
    if (!r.ok) return { up: false, error: r.error || 'HTTP ' + r.status, list: [] };
    const list = (r.data && (r.data.providers || r.data.items)) || [];
    let claude = null;
    const c = await stationGet('auth/claude-cli/status', 8000);
    if (c.ok && c.data) claude = c.data;
    return { up: true, list, claude };
  }
  function readySet(sp) {
    const s = new Set(sp.list.filter(p => p && p.configured !== false && p.unattendedReady === true).map(p => String(p.id || p.provider)));
    if (sp.claude && sp.claude.installed && sp.claude.loggedIn) s.add('claude-cli');
    s.delete('ollama'); s.delete('starnet');
    return s;
  }

  /* ---------- charter ---------- */
  const PH = /\{\{[A-Z_]+\}\}|<(?!none yet>)[A-Za-z][^<>\n]{0,200}>/g;   // the same test as onboard.js --certify
  function placeholders(text) { const body = String(text || '').replace(/<!--[\s\S]*?-->/g, '').replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, ''); return [...new Set(body.match(PH) || [])]; }
  function section(md, heading) {
    const re = new RegExp('(^|\\n)## ' + heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[ \\t]*\\n([\\s\\S]*?)(?=\\n## |$)');
    const m = re.exec(md); return m ? m[2].trim() : null;
  }
  function setSection(md, heading, body, before) {
    const re = new RegExp('(^|\\n)(## ' + heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[ \\t]*\\n)([\\s\\S]*?)(?=\\n## |$)');
    if (re.test(md)) return md.replace(re, (all, lead, head) => lead + head + '\n' + body + '\n');
    const at = md.indexOf('\n## ' + before);
    const block = '\n## ' + heading + '\n\n' + body + '\n';
    return at >= 0 ? md.slice(0, at) + '\n' + block + md.slice(at) : md.trimEnd() + '\n' + block;
  }
  const clean = s => String(s || '').replace(/\r/g, '').trim().replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\{\{/g, '{ {');
  const plain = s => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  function charterFields() {
    let md = ''; try { md = fs.readFileSync(F.charter, 'utf8'); } catch (_) {}
    const ph = placeholders(md);
    const val = s => (s && !placeholders(s).length ? s : '');
    let mandate = val(section(md, 'Mandate')) || '', forWhom = '';
    const fw = /\n?\*\*For whom:\*\*\s*([^\n]*)/.exec(mandate);
    if (fw) { forWhom = fw[1].trim(); mandate = mandate.replace(fw[0], '').trim(); }
    return { exists: !!md, placeholders: ph.map(x => x.slice(0, 60)), mandate: plain(mandate), forWhom: plain(forWhom),
      outOfScope: plain(val(section(md, 'What is out of scope')) || ''), firstGoal: plain(val(section(md, 'First goal')) || '') };
  }

  /* ---------- onboarding gate ---------- */
  function onboardingQuestions(qs) { return qs.filter(q => q.from === 'onboard.js' || /^onboarding\b/i.test(String(q.about || ''))); }
  // answer the onboard.js batch when every line it asks is the candidate-default line (other lines stay open for the owner)
  async function resolveGate(note) {
    const out = [];
    let qs = []; try { qs = tool('inbox.js').openQuestions(); } catch (_) {}
    for (const q of onboardingQuestions(qs)) {
      const items = String(q.q || '').split('\n').filter(l => /^\s*-\s/.test(l));
      if (!items.length || !items.every(l => /Hiring candidates default/i.test(l))) continue;
      const r = await run('inbox.js', ['answer', '--id', q.id, '--a', 'resolved in Setup: ' + note, '--by', owner(), '--quiet']);
      out.push({ id: q.id, ok: r.code === 0 });
    }
    await run('onboard.js', ['--record', 'candidate-default', 'ok', '--note', note]);
    return out;
  }

  /* ---------- status ---------- */
  function validTz(tz) { try { new Intl.DateTimeFormat('en', { timeZone: String(tz) }); return !!tz; } catch (_) { return false; } }
  async function status() {
    const cfg = readJson(F.company, {}) || {};
    const pol = readJson(F.policy, {}) || {};
    const cd = pol.candidateDefault || {};
    const b = budget();
    const unmetered = unmeteredList(b);
    const sp = await stationProviders();
    const ready = readySet(sp);
    const onb = readJson(F.onboarding, {}) || {};
    let guards = null; try { guards = (await runApi('guardrails.js', ['show', '--json'])); } catch (_) {}
    let gov = null; try { gov = await runApi('governance.js', ['show', '--json']); } catch (_) {}
    let qs = []; try { qs = tool('inbox.js').openQuestions(); } catch (_) {}
    const ch = charterFields();
    const ownerName = (cfg.owner && cfg.owner.name) || '';
    const steps = [];
    const add = (id, title, st, why) => steps.push({ id, title, status: st, why });

    const coBad = !cfg.name || cfg.name === 'Unfounded Company' ? 'the company has no name yet' : !ownerName || ownerName === 'Owner' ? 'the owner has no name yet' : !validTz(cfg.timezone) ? 'the timezone is not a valid IANA zone' : null;
    add('company', 'Company', coBad ? 'needs' : 'done', coBad ? 'Every tool signs and dates its work with these: ' + coBad + '.' : cfg.name + ', run by ' + ownerName + ', on ' + cfg.timezone + ' time.');

    const cdReady = cd.provider && ready.has(cd.provider);
    const offer = offerOf(cd.provider);
    add('provider', 'AI provider', cdReady ? 'done' : 'needs', !sp.up ? 'The station is not answering (' + sp.error + '), so no AI provider can be checked or connected. Start it, then come back.'
      : cdReady ? 'New hires interview on ' + plainModel(cd.model, offer ? offer.name : cd.provider) + ', which the station has ready.'
      : 'Your crew needs an AI to think with. ' + (ready.size ? 'The station has ' + [...ready].join(', ') + ' ready, but new hires default to ' + (cd.provider || 'nothing') + '.' : 'The station has no AI provider connected yet.'));

    const cdMetered = cd.provider && !unmetered.includes(cd.provider);
    const daily = Number(b.dailyUsd) || 0;
    const budgetNeeds = cdMetered && daily <= 0;
    add('budget', 'Budget', budgetNeeds ? 'needs' : b.setBy ? 'done' : 'optional', budgetNeeds ? 'New hires run on ' + cd.provider + ', which bills per token, and the daily cap is $0, so nothing they do can run.'
      : daily > 0 ? 'Up to $' + daily + ' a day on pay-per-token AI' + (Number(b.perAgentUsd) > 0 ? ', at most $' + b.perAgentUsd + ' per crew member.' : '.')
      : 'Subscription only: $0 a day on pay-per-token AI. Fine while the crew runs on a subscription.');

    const govSet = fs.existsSync(F.gov);
    add('governance', 'How much the company decides alone', govSet ? 'done' : 'optional', (govSet ? 'Set to ' : 'Starts at ') + ((gov && gov.presetLabel) || 'the default') + '. The four owner gates (money beyond the cap, access, ownership, outside commitments) always come to you.');

    add('charter', 'Charter', ch.exists && !ch.placeholders.length ? 'done' : 'needs', !ch.exists ? 'company/CHARTER.md is missing.' : ch.placeholders.length ? 'The crew reads the charter to know what the company is for. It still has ' + ch.placeholders.length + ' blank' + (ch.placeholders.length > 1 ? 's' : '') + ' to fill.' : 'The crew knows what the company does and what it will not do.');

    const off = guards ? (guards.off || []) : null;
    add('guardrails', 'Guardrails', off && off.length ? 'optional' : off ? 'done' : 'needs', !off ? 'Could not read the guardrails.' : off.length ? off.length + ' switched off by you: ' + off.join(', ') + '.' : 'All ' + ((guards.guards || []).length || 10) + ' are on. You can switch some off later in Controls.');

    const res = (onb.checks && onb.checks.results) || {};
    const failed = Object.keys(res).filter(k => !res[k].ok);
    add('certify', 'Certify', onb.certified ? 'done' : 'needs', onb.certified ? 'All checks passed' + (onb.certifiedAt ? ' on ' + String(onb.certifiedAt).slice(0, 10) : '') + '. The company is operational.'
      : onb.checks ? failed.length + ' of ' + Object.keys(res).length + ' checks still failing: ' + failed.join(', ') + '.' : 'The final check that the company can actually run. It has not run yet.');

    const providers = OFFER.map(offerNow).map(o => {
      const st = sp.list.find(p => String(p.id) === o.id) || null;
      return Object.assign({}, o, { ready: ready.has(o.id), present: !!(st && st.credential && st.credential.present), reason: st ? st.reason || null : null,
        isDefault: cd.provider === o.id, metered: !unmetered.includes(o.id) });
    });
    return { ok: true, certified: !!onb.certified, done: steps.filter(s => s.status === 'done').length, total: steps.length, steps,
      company: { name: cfg.name || '', ownerName, timezone: cfg.timezone || 'UTC' },
      station: { up: sp.up, error: sp.up ? null : sp.error, url: co.STATION_URL, claude: sp.claude },
      providers, candidateDefault: cd,
      budget: { dailyUsd: daily, perAgentUsd: Number(b.perAgentUsd) || 0, unmeteredProviders: unmetered, setBy: b.setBy || '', setAt: b.setAt || '' },
      governance: gov ? { preset: gov.preset, presetLabel: gov.presetLabel, presets: gov.presets, chosen: govSet } : null,
      charter: ch,
      guardrails: guards ? { off: guards.off || [], sandbox: !!guards.sandbox, guards: (guards.guards || []).map(g => ({ name: g.name, on: g.on, fixed: !!g.fixed, blocks: g.blocks })) } : null,
      checks: Object.entries(res).map(([id, r]) => ({ id, ok: !!r.ok, missing: r.missing || null })), lastCertify: (onb.checks || {}).at || null,
      onboardingQuestions: onboardingQuestions(qs) };
  }

  /* ---------- writes ---------- */
  function setCompany(b) {
    const cfg = readJson(F.company, null); if (!cfg) bad('company/company.json is missing or not JSON', 500);
    const changes = [];
    if (b.name !== undefined) {
      const n = String(b.name).trim(); if (!n || n.length > 80) bad('name must be 1 to 80 characters');
      if (n !== cfg.name) { changes.push('name "' + cfg.name + '" -> "' + n + '"'); if (!cfg.shortName || cfg.shortName === cfg.name || cfg.shortName === 'company') cfg.shortName = n; cfg.name = n; }
    }
    if (b.ownerName !== undefined) {
      const n = String(b.ownerName).trim(); if (!n || n.length > 60 || /^-/.test(n) || /[\n\r]/.test(n)) bad('owner name must be 1 to 60 characters on one line');
      cfg.owner = cfg.owner || {};
      if (n !== cfg.owner.name) {
        changes.push('owner "' + cfg.owner.name + '" -> "' + n + '"');
        if (!cfg.owner.addressAs || cfg.owner.addressAs === cfg.owner.name || cfg.owner.addressAs === 'the owner') cfg.owner.addressAs = n;
        cfg.owner.name = n;
      }
    }
    if (b.timezone !== undefined) {
      const tz = String(b.timezone).trim(); if (!validTz(tz) || !/^[A-Za-z_]+(\/[A-Za-z0-9_+\-]+)*$/.test(tz)) bad('timezone must be an IANA zone such as Europe/London or America/New_York');
      if (tz !== cfg.timezone) { changes.push('timezone ' + cfg.timezone + ' -> ' + tz); cfg.timezone = tz; }
    }
    if (!changes.length) return { ok: true, unchanged: true };
    writeJson(F.company, cfg);
    Object.assign(co.config, { name: cfg.name, shortName: cfg.shortName, timezone: cfg.timezone, owner: cfg.owner });
    setOwner(cfg.owner.name);
    decision('set the company: ' + changes.join(', '));
    return { ok: true, changes, company: { name: cfg.name, ownerName: cfg.owner.name, timezone: cfg.timezone } };
  }

  async function pickModel(id, pol, want) {
    const fam = (pol.allowed || {})[id];
    if (want) return String(want);
    if (fam && (fam.models || []).length) { const tiers = fam.tiers || {}; return fam.models.find(m => tiers[m] === 'light') || fam.preferred || fam.models[0]; }
    const r = await stationGet('models/' + encodeURIComponent(id), 8000);
    const ids = r.ok ? ((r.data && (r.data.models || r.data.data || r.data.items)) || []).map(m => typeof m === 'string' ? m : m && m.id).filter(Boolean) : [];
    return ids.find(m => /haiku/i.test(m)) || ids.find(m => /deepseek/i.test(m)) || FALLBACK_MODEL[id] || ids[0] || null;
  }
  async function setDefault(id, model, unmeteredConfirmed) {
    const pol = readJson(F.policy, null); if (!pol) bad('company/model-policy.json is missing or not JSON', 500);
    const m = await pickModel(id, pol, model); if (!m) bad('no model known for ' + id);
    pol.allowed = pol.allowed || {};
    if (!pol.allowed[id]) pol.allowed[id] = { models: [m], _addedBy: 'owner, console Setup ' + new Date().toISOString().slice(0, 10) };
    else if (!(pol.allowed[id].models || []).includes(m)) pol.allowed[id].models = (pol.allowed[id].models || []).concat([m]);
    const prev = pol.candidateDefault || {};
    pol.candidateDefault = Object.assign({}, prev, { provider: id, model: m, effort: prev.effort || 'high', setBy: owner(), setAt: new Date().toISOString(), why: 'owner connected ' + id + ' in console Setup' });
    writeJson(F.policy, pol);
    decision('set the hiring candidate default to ' + id + '/' + m + (prev.provider ? ' (was ' + prev.provider + '/' + prev.model + ')' : ''));
    if (unmeteredConfirmed) {
      const b = readJson(F.budget, null) || readJson(F.budgetDefault, {});
      const list = unmeteredList(b);
      if (!list.includes(id)) { b.unmeteredProviders = list.concat([id]); writeJson(F.budget, b); decision('marked ' + id + ' as subscription-billed (dispatch-budget.json unmeteredProviders)'); }
    }
    const b = budget();
    const runnable = unmeteredList(b).includes(id) || Number(b.dailyUsd) > 0;
    const gate = runnable ? await resolveGate('candidates default to ' + id + '/' + m) : [];
    // the Founder's loop thinks with the provider the owner just picked (created here if onboarding has not yet)
    let founderLoop = null;
    try { const FL = tool('founder-loop.js'); const r = await FL.ensure({ provider: id, model: m }); founderLoop = { ok: r.ok, text: r.ok ? FL.summary(r) : r.error }; if (r.ok) await run('onboard.js', ['--record', 'founder-loop', 'ok', '--note', FL.summary(r)]); }
    catch (e) { founderLoop = { ok: false, text: e.message }; }
    if (founderLoop.ok) decision('moved the Founder loop to ' + id + '/' + m);
    return { provider: id, model: m, runnable, gateAnswered: gate, founderLoop };
  }

  async function connect(b) {
    const id = String(b.provider || '');
    const o = offerOf(id); if (!o) bad('provider must be one of ' + OFFER.map(x => x.id).join(', '));
    const sp = await stationProviders();
    if (!sp.up) throw new HttpError(502, 'station unreachable: ' + sp.error);
    if (o.how === 'signin') {
      if (!(sp.claude && sp.claude.installed && sp.claude.loggedIn)) bad(sp.claude && sp.claude.installed === false ? 'Claude Code is not installed on the station machine' : 'Claude is not signed in on the station yet: finish the sign-in first');
      return Object.assign({ ok: true, connected: true }, await setDefault(id, b.model, false));
    }
    let key = String(b.key || '').replace(/\s+/g, '');
    // MiniMax: the endpoint asked for (or the stored one). Switching it re-checks the key on the new endpoint before
    // anything is saved; with no key pasted, the key the company already holds is used for that check.
    const mm = id === 'custom' ? mmWanted(b) : null;
    const mmPrev = mm ? mmNow() : null;
    const switching = !!(mm && mm.explicit && !MME.same(mm.ep, mmPrev));
    let keyFromStore = false;
    if (switching && !key) { key = MME.storedKey(co.ROOT); keyFromStore = !!key; if (!key) bad('paste your MiniMax key: switching the endpoint checks the key against the new one first'); }
    const baseUrl = mm ? mm.ep.baseUrl : String(b.baseUrl || o.baseUrl || '').trim();
    const presentAlready = readySet(sp).has(id);
    if (!key && !presentAlready) bad('paste the API key');
    if (key) {
      const v = await stationPost('providers/validate', { provider: id, key, baseUrl: baseUrl || undefined }, 25000);
      if (!v.ok || !v.data || !v.data.credentialVerified) {
        // MiniMax: in plain words (the owner sees this line as it is); the station's own words for any other provider
        if (mm) bad('MiniMax ' + MME.plain(mm.ep) + ' did not accept ' + (keyFromStore ? 'the key on file' : 'that key') + (v.data && v.data.reachable === false ? ': it could not be reached from the station machine.' : '. Check the key, or pick the region where your account is.'));
        bad('the provider did not accept that key' + (v.data && v.data.error ? ': ' + scrubKey(v.data.error, key) : v.error ? ': ' + scrubKey(v.error, key) : ''));
      }
      let c = await stationPost('providers/connect', { provider: id, key, baseUrl: baseUrl || undefined }, 50000);
      if (!(c.ok && c.data && c.data.ok)) {
        if (c.data && c.data.code && c.data.code !== 'no-page') bad((c.data && c.data.error) || 'the station did not save the key');
        // a headless station: hand the key to the store unattended runs read (what the terminal's /connect does)
        c = await stationPost('providers/engine-key', { provider: id, key, baseUrl: baseUrl || undefined }, 20000);
        if (!(c.ok && c.data && c.data.ok)) throw new HttpError(502, 'the station did not save the key: ' + ((c.data && c.data.error) || c.error || 'HTTP ' + c.status));
      }
    }
    // the key worked on this endpoint and the station holds it: now the endpoint is saved (one place: company.json)
    let endpoint = null;
    if (mm) { if (mm.explicit && (switching || !mmPrev.stored)) saveEndpoint(mm.ep, mmPrev); endpoint = mmView(mm.explicit ? mm.ep : mmPrev); }
    // keepDefault: only set or replace the key (Settings › Connections and keys); who new hires run on stays as it is
    if (b.keepDefault === true) {
      if (!key) bad('paste the API key');
      if (!keyFromStore) decision((presentAlready ? 'replaced' : 'set') + ' the ' + id + ' API key');
      return { ok: true, connected: true, provider: id, keyOnly: true, switched: switching, endpoint };
    }
    return Object.assign({ ok: true, connected: true, switched: switching, endpoint }, await setDefault(id, b.model, !!b.subscription || (o.unmetered && b.subscription !== false)));
  }
  async function validate(b) {
    const id = String(b.provider || ''); const o = offerOf(id); if (!o || o.how !== 'key') bad('validate takes a key provider');
    const key = String(b.key || '').replace(/\s+/g, ''); if (!key) bad('paste the API key');
    const mm = id === 'custom' ? mmWanted(b) : null;
    const v = await stationPost('providers/validate', { provider: id, key, baseUrl: mm ? mm.ep.baseUrl : b.baseUrl || o.baseUrl || undefined }, 25000);
    if (!v.ok && !v.data) throw new HttpError(502, 'station unreachable: ' + scrubKey(v.error || 'HTTP ' + v.status, key));
    const d = v.data || {};
    return Object.assign({ ok: true, provider: id, valid: !!d.credentialVerified, reachable: !!d.reachable, error: d.credentialVerified ? null : scrubKey(d.error || 'not verified', key), modelCount: d.modelCount || 0 },
      mm ? { endpoint: mmView(mm.ep) } : {});
  }
  // "Find my endpoint": try the key on each MiniMax region through the station (never from the browser), in order,
  // and name the one that answers. Nothing is saved; the owner then connects with that region selected.
  async function detect(b) {
    const id = String(b.provider || 'custom'); if (id !== 'custom') bad('finding the endpoint is for MiniMax only');
    let key = String(b.key || '').replace(/\s+/g, ''); let fromStore = false;
    if (!key) { key = MME.storedKey(co.ROOT); fromStore = !!key; }
    if (!key) bad('paste your MiniMax key first');
    const tried = [];
    for (const region of MME.ORDER) {
      const ep = MME.resolve({ region });
      const v = await stationPost('providers/validate', { provider: id, key, baseUrl: ep.baseUrl }, 25000);
      if (!v.ok && !v.data) throw new HttpError(502, 'the station is not answering, so the key could not be tried (' + scrubKey(v.error || 'HTTP ' + v.status, key) + ')');
      const d = v.data || {};
      const rejected = !d.credentialVerified && (d.status === 'rejected' || [401, 403].includes(Number(d.httpStatus)) || /\b(401|403)\b|reject|invalid/i.test(String(d.error || '')));
      const t = { region, label: ep.label, valid: !!d.credentialVerified, reachable: d.reachable !== false, rejected, error: d.credentialVerified ? null : scrubKey(d.error || 'not verified', key) };
      tried.push(t);
      if (t.valid) break;
    }
    const hit = tried.find(t => t.valid);
    const keyWord = fromStore ? 'The key on file' : 'Your key';
    if (hit) return { ok: true, found: hit.region, label: hit.label, why: 'found', tried, fromStore,
      text: keyWord + ' works on ' + hit.label + '.' + (hit.region === 'global' ? '' : ' ' + tried.filter(t => !t.valid).map(t => t.label).join(' and ') + ' did not accept it.') };
    const down = tried.filter(t => !t.reachable);
    const why = !down.length ? 'bad-key' : down.length === tried.length ? 'network' : 'mixed';
    const text = why === 'bad-key' ? 'Neither Global nor Mainland China accepted ' + (fromStore ? 'the key on file' : 'this key') + '. Check that you copied all of it, from the MiniMax site where your account is, and that the plan is active.'
      : why === 'network' ? 'Neither MiniMax region could be reached from the station machine, so the key was not checked. Check the station\'s internet connection and try again.'
      : tried.map(t => t.label + (t.reachable ? ' did not accept the key' : ' could not be reached')).join('; ') + '. Try again in a minute; if it keeps happening, check the station\'s internet connection.';
    return { ok: true, found: null, why, tried, fromStore, text };
  }

  async function setBudget(b) {
    const num = (v, n) => { const x = Number(v); if (!Number.isFinite(x) || x < 0 || x > 10000) bad(n + ' must be a number from 0 to 10000'); return Math.round(x * 100) / 100; };
    const daily = num(b.dailyUsd, 'dailyUsd');
    const per = b.perAgentUsd === undefined || b.perAgentUsd === null || b.perAgentUsd === '' ? 0 : num(b.perAgentUsd, 'perAgentUsd');
    if (per > daily && daily > 0) bad('the per-agent share cannot be more than the daily cap');
    const cur = readJson(F.budget, null) || readJson(F.budgetDefault, {});
    const before = { dailyUsd: cur.dailyUsd, perAgentUsd: cur.perAgentUsd };
    Object.assign(cur, { dailyUsd: daily, perAgentUsd: daily > 0 ? per : 0, setBy: owner(), setAt: new Date().toISOString(), why: String(b.why || 'owner, console Setup').slice(0, 200) });
    writeJson(F.budget, cur);
    decision('set the metered budget: dailyUsd ' + before.dailyUsd + ' -> ' + cur.dailyUsd + ', perAgentUsd ' + before.perAgentUsd + ' -> ' + cur.perAgentUsd + ' (company/work/finance/dispatch-budget.json)');
    const cd = (readJson(F.policy, {}) || {}).candidateDefault || {};
    let gate = [];
    if (daily > 0 && cd.provider && !unmeteredList(cur).includes(cd.provider)) {
      const sp = await stationProviders();
      if (readySet(sp).has(cd.provider)) gate = await resolveGate('metered cap $' + daily + '/day for ' + cd.provider + '/' + cd.model);
    }
    return { ok: true, dailyUsd: cur.dailyUsd, perAgentUsd: cur.perAgentUsd, gateAnswered: gate };
  }

  // the charter as it stands, for Setup to show (rendered) and edit
  function charterView() {
    let text = ''; try { text = fs.readFileSync(F.charter, 'utf8'); } catch (_) {}
    let at = null; try { at = fs.statSync(F.charter).mtime.toISOString(); } catch (_) {}
    return { ok: true, text, at, placeholders: placeholders(text), fields: charterFields() };
  }
  // the owner edits the whole text: saved as written; blanks left are reported, and the step stays "needs" until none
  function setCharterText(text) {
    text = String(text || '').replace(/\r/g, '');
    if (text.trim().length < 40) bad('the charter is nearly empty: write at least a mandate');
    if (text.length > 100000) bad('the charter is too long (100000 characters at most)');
    if (!/^## /m.test(text)) bad('keep the charter\'s ## headings');
    writeFile(F.charter, text.endsWith('\n') ? text : text + '\n');
    decision('edited the charter text (company/CHARTER.md)');
    return Object.assign(charterView(), { ok: true, saved: true });
  }
  function setCharter(b) {
    if (typeof b.text === 'string') return setCharterText(b.text);
    const f = { mandate: clean(b.mandate), forWhom: clean(b.forWhom), outOfScope: clean(b.outOfScope), firstGoal: clean(b.firstGoal) };
    if (f.mandate.length < 10) bad('say in a sentence or two what the company does');
    if (!f.outOfScope) bad('say what the company will not do (write "Nothing yet" if you have no limits in mind)');
    for (const [k, v] of Object.entries(f)) if (v.length > 4000) bad(k + ' is too long (4000 characters at most)');
    let md = ''; try { md = fs.readFileSync(F.charter, 'utf8'); } catch (_) {}
    if (!md) { try { md = fs.readFileSync(path.join(__dirname, '..', 'company', 'CHARTER.md'), 'utf8'); } catch (_) { bad('no charter template (company/CHARTER.md)', 500); } }
    const cfg = readJson(F.company, {}) || {};
    md = md.replace(/\{\{COMPANY\}\}/g, cfg.name || 'The company').replace(/\{\{OWNER\}\}/g, (cfg.owner && cfg.owner.name) || owner());
    md = md.replace(/\n?<!--\s*Template\.[\s\S]*?-->\n?/, '\n');
    md = setSection(md, 'Mandate', f.mandate + (f.forWhom ? '\n\n**For whom:** ' + f.forWhom.replace(/\n+/g, ' ') : ''), 'Structure');
    md = setSection(md, 'What is out of scope', f.outOfScope, 'Structure');
    md = setSection(md, 'First goal', f.firstGoal || 'The Founder proposes the first goal in its first report.', 'Structure');
    md = md.replace(/\n{3,}/g, '\n\n');
    const left = placeholders(md);
    if (left.length) throw new HttpError(400, 'the charter still has blanks the form does not cover: ' + left.slice(0, 4).join(' · ') + ' (edit company/CHARTER.md)', { placeholders: left });
    writeFile(F.charter, md);
    decision('wrote the charter (company/CHARTER.md): mandate, scope, first goal');
    return { ok: true, placeholders: [], charter: charterFields() };
  }

  return {
    routes: [
      ['GET', /^\/api\/setup$/, () => status()],
      ['POST', /^\/api\/setup\/company$/, (m, q, b) => setCompany(b)],
      ['POST', /^\/api\/setup\/provider$/, (m, q, b) => connect(b)],
      ['POST', /^\/api\/setup\/provider\/validate$/, (m, q, b) => validate(b)],
      ['POST', /^\/api\/setup\/provider\/detect$/, (m, q, b) => detect(b)],
      ['GET', /^\/api\/setup\/minimax-endpoint$/, () => ({ ok: true, endpoint: mmView(mmNow()) })],
      ['POST', /^\/api\/setup\/budget$/, (m, q, b) => setBudget(b)],
      ['POST', /^\/api\/setup\/charter$/, (m, q, b) => setCharter(b)],
      ['GET', /^\/api\/setup\/charter$/, () => charterView()],
    ],
    onboardingQuestions, placeholders, minimaxEndpoint: mmNow, mmWanted, saveEndpoint,
  };
};
