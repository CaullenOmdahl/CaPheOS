/* owner-scope.js — what may go to the owner, and how it must read. Used by the ask composer (inbox.js ask, and through
 * it approvals.js ask) and by the chat lint (console/command-ask.js ownerAsk).
 *
 * The owner is a busy non-technical person. On 2026-11-17 the sandbox Founder asked them for health-check plumbing three
 * times (q-559031 "the kill switch … systemd start limit … daemon-reload"; q-623640 "add a healthchecks check named
 * recorder, period 5, grace 15, paste its ping URL"; q-766259 "the healthy-ping timer … is not on the service register
 * … no new egress"), and the owner said: handle these on your own, or make it dead simple for a layman.
 *
 * THE OWNER SCOPE. Only these reach the owner:
 *   money      money beyond the company's own limits (a spend, a purchase, a subscription, the budget)
 *   account    an account or identity in the OWNER's name (a sign-up, a sign-in, a key only they can get)
 *   legal      legal, ownership or commitment decisions (a contract, an agreement, who owns what)
 *   direction  company direction and priorities
 *   risk       risk acceptance the governance level reserves for the owner (an approval category at `approve`)
 *   gate       the fixed gates (governance.json `fixed`: access, ownership, commitment, spendBeyondCap)
 * Everything else — infrastructure, monitoring, health checks, tooling, service registers, timers, framework bugs,
 * internal process — is the CREW's: the risk, tools or floor seat, or a framework request (harness-change.js propose).
 *
 *   classify({message, details, about, category, level, fixed}, ctx) -> {scope: 'owner'|'crew', owner: [topic], crew: [{area, hit}], why, level?, route?}
 *       a category is the owner's only at its REAL governance level (lib/governance.js level(), unless o.level says
 *       which level the caller already read): approve (or triage, which reads as approve) = the owner decides; auto =
 *       the crew decides (route 'crew'); notify = the crew decides and the owner hears of it in the daily digest (route
 *       'digest'). A fixed owner gate is always the owner's.
 *   plainScore(text, {approval}) -> {ok, score, sentences, words, longest, jargon, numbers, gain, fallback, problems}
 *       at most 2 sentences of at most 25 words and 300 characters; no jargon word, code span, path, file or tool name,
 *       id, clock time, hash or setting; at most 2 figures besides money; it says what the owner gets or risks and what
 *       happens if they skip it. A money request ("May I spend $40 on X?") states its risk (the amount) and its default
 *       (nothing is spent); an approval record states its own default (deny).
 *   suggestPlain(text, cls) -> a plain two-sentence version (a template where words are missing)
 *   routeFor(cls, from, seats) -> {to, line}: where a crew-scope ask goes instead
 *   backoff({about, ref, message, approvalDigest, changed}, rows, now) -> null | {id, at, answer}: the same topic answered
 *       "not now" within 7 days (refused unless `changed` says what is materially different)
 *   check(o, {rows, now, seats, govOpts, rulings}) -> null | {code: 'crew-scope'|'ruling'|'backoff'|'plain', error, suggestion?}
 *       'ruling': a standing owner ruling (lib/owner-rulings.js) covers it: crew-decides or never-ask, so it is not
 *       asked; an 'ask' ruling keeps a category the governance level gives the crew with the owner. The fixed gates
 *       always reach the owner, whatever a ruling says.
 *   wordsProblems(text) -> [offending word] : the jargon, paths, ids, commands, model ids and clock specs in a text
 *       (what lib/owner-card.js refuses in an owner card's plain parts)
 * Everything here is deterministic (regexes and counts); nothing calls a model. */
'use strict';

const BACKOFF_DAYS = 7;
const MAX_SENTENCES = 2, MAX_WORDS_PER_SENTENCE = 25, MAX_CHARS = 300, MAX_NUMBERS = 2, MIN_SCORE = 60;

/* ---- the owner's topics ---- */
const OWNER = {
  money: [/\$\s?\d/, /\b\d+(?:[.,]\d+)?\s?(?:usd|eur|gbp|dollars?|euros?|pounds)\b/i,
    /\b(?:spend|spending|pay|paying|payment|buy|buying|purchase|subscription|subscribe|invoice|refund|price|pricing|budget|paid plan|paid tier|upgrade to (?:the )?paid)\b/i,
    /\bhow much (?:of )?(?:this|the|each|a) (?:week|month|day|subscription|plan|budget)\b/i, /\b(?:spending|monthly|daily|weekly|usage|budget) (?:cap|limit)s?\b|\b(?:the|our|a) cap\b|\ballowance\b|\bquota\b/i],
  account: [/\bsign(?:ing)?[- ]?(?:up|in)\b/i, /\blog(?:ging)?[- ]?in\b/i,
    /\b(?:create|make|open|register|set up)\s+(?:an?|your|the|one)\s+(?:(?:free|new|own)\s+)?(?:[\w.-]+\s+){0,2}accounts?\b/i,
    /\baccounts?\s+in\s+your\s+(?:own\s+)?name\b/i, /\bin your (?:own )?name\b/i, /\byour (?:email|phone number|identity|passport|id card)\b/i,
    /\bverify your identity\b/i, /\b(?:key|login|account)s? only you can\b/i, /\bonly you can (?:get|create|open|sign)\b/i,
    // a key the owner gets from their own account ("Paste your Quotely Stream API key"): the word API alone never makes it the crew's
    /\b(?:paste|send|give|share|copy)\b[^.?!]{0,60}\b(?:api |access |secret )?key\b/i, /\byour (?:own )?(?:[\w-]+ ){0,3}(?:api |access |secret )?key\b/i],
  legal: [/\b(?:contract|agreement|terms of (?:service|use)|legal|lawyer|liabilit(?:y|ies)|nda|ownership|equity|incorporat\w+|trademark|copyright)\b/i,
    /\bsign (?:the|a|an|our) (?:[\w-]+ )?(?:contract|agreement|deal|lease|pilot)\b/i, /\bcommit(?:s|ting)? (?:us|the company) to\b/i, /\bwho owns\b/i],
  direction: [/\b(?:direction|priorit(?:y|ies|ise|ize)|strategy|pivot|mandate|charter)\b/i, /\bfocus (?:on|first)\b/i,
    /\bwhich (?:market|product|idea|customers?|line of business)\b/i, /\b(?:our|the company's) (?:first |next |main )?goal\b/i, /\bwhat the company (?:does|should)\b/i],
  risk: [/\baccept (?:the|this|that) risk\b/i, /\brisk (?:you|the owner) (?:accept|take)s?\b/i, /\b(?:ok|okay|comfortable) with (?:the |this |that )?risk\b/i],
};
// approval categories: the fixed gates and the money/people/outside ones are the owner's by their nature; any other
// category that still reached the owner is there because governance has it at `approve` (risk the owner reserved)
const CATEGORY_TOPIC = { spend: 'money', budget: 'money', spendBeyondCap: 'money', access: 'account', ownership: 'legal', commitment: 'legal',
  hiring: 'direction', release: 'direction', packs: 'direction', external: 'risk' };

/* ---- the crew's areas: each signal names the seat it belongs to ---- */
const CREW = [
  ['monitoring', 'risk', /\bhealth[- ]?checks?(?:\.io)?\b|\bheart[- ]?beats?\b|\bping (?:url|address|urls)\b|\bpings?\b|\bwatchdog\b|\bmonitor(?:s|ing)?\b|\buptime\b|\balarm\b|\bkill[- ]switch\b|\begress\b|\bliveness\b/i],
  ['monitoring', 'risk', /\bperiod\s+\d|\bgrace\b|\bgrace period\b/i],
  ['infrastructure', 'tools', /\bsystemd\b|\bsystemctl\b|\bdaemon[- ]?reload\b|\b(?:service|timer)\s+units?\b|\bunits?\b|\btimers?\b|\boneshot\b|\bstart[- ]?limit\b|\bcron(?:tab)?\b|\bports?\b|\bfirewall\b|\bufw\b|\bdocker\b|\bcontainers?\b|\b[\w.-]+\.(?:service|timer|socket)\b/i],
  ['tooling', 'tools', /\bservice register\b|\bregisters?\b|\badopt(?:ing|s|ed)?\b|\bmodules?\b|\btool(?:s|ing)?\b|\bscripts?\b|\bconfig(?:uration)?\b|\bguardrails?\b|\bdeps?\b|\bpackages?\b|\bendpoints?\b|\bwebhooks?\b|\b(?:api|cli|sdk)\b/i],
  ['process', 'floor', /\bdut(?:y|ies)\b|\bhandoffs?\b|\broutines?\b|\bdispatcher\b|\bqueue\b|\bschedul(?:e|es|er|ing)\b|\bcadence\b|\blogs?\b|\bjournal\b/i],
  ['framework', 'framework', /\bframework\b|\bhouse rules?\b|\bharness\b|\b[\w-]+\.(?:js|py|sh|jsonl?)\b|\b(?:hc|fr)-\d{3,}\b|\bbug\b|\bregression\b/i],
];

function hitsOf(text, list) { const out = []; for (const re of list) { const m = String(text || '').match(re); if (m) out.push(m[0]); } return out; }

/* classify(o) — the owner topics and crew areas the ask touches, and which scope it is. The lead (o.message, else the
 * first sentences of o.q) decides; details only add crew signals. */
/* the governance level of a category as it is now (o.level when the caller read it already); fails closed */
function levelOf(cat, o, ctx) {
  if (o && o.level) return String(o.level);
  try { return require('./governance').level(cat, Object.assign({}, (ctx && ctx.govOpts) || {})); } catch (_) { return 'approve'; }
}
function classify(o, ctx) {
  o = o || {};
  const lead = String(o.message || o.q || '');
  const all = lead + '\n' + String(o.details || '') + '\n' + String(o.about || '');
  const owner = [];
  const cat = o.category ? String(o.category) : '';
  if (cat) owner.push(o.fixed ? 'gate' : (CATEGORY_TOPIC[cat] || 'risk'));
  for (const [topic, res] of Object.entries(OWNER)) if (hitsOf(lead, res).length && !owner.includes(topic)) owner.push(topic);
  const crew = [];
  for (const [area, seat, re] of CREW) { const m = all.match(new RegExp(re.source, 'gi')); if (m) for (const h of new Set(m.map(x => x.toLowerCase()))) crew.push({ area, seat, hit: h }); }
  let scope, why, level, route;
  if (cat && !o.fixed) level = levelOf(cat, o, ctx);
  if (cat && !o.fixed && (level === 'auto' || level === 'notify') && !o.ownerAsks) {
    scope = 'crew'; route = level === 'notify' ? 'digest' : 'crew';
    why = 'self-governance has ' + cat + ' at ' + level + ', so the crew decides' + (level === 'notify' ? ' and the owner hears of it in the daily digest' : '');
  }
  else if (cat) { scope = 'owner'; why = o.fixed ? 'a fixed owner gate (' + cat + ')' : 'governance has ' + cat + ' at ' + (level === 'triage' ? 'triage (escalated)' : level || 'approve') + ', so the owner decides'; }
  else if (owner.length) { scope = 'owner'; why = 'it asks the owner about ' + owner.join(', '); }
  else if (crew.length) { scope = 'crew'; why = 'it is ' + [...new Set(crew.map(c => c.area))].join(' and ') + ' (' + [...new Set(crew.map(c => c.hit))].slice(0, 6).join(', ') + '), which is the crew\'s job'; }
  else { scope = 'owner'; why = 'no crew signal: a plain question for the owner'; }
  const out = { scope, owner, crew, why };
  if (level) out.level = level; if (route) out.route = route;
  return out;
}

/* ---- the plain-language scorer ---- */
const JARGON_WORDS = ['period', 'grace', 'egress', 'duty', 'duties', 'register', 'registers', 'unit', 'units', 'timer', 'timers', 'systemd',
  'systemctl', 'daemon', 'daemon-reload', 'api', 'apis', 'cli', 'sdk', 'token', 'tokens', 'endpoint', 'endpoints', 'webhook', 'webhooks', 'port', 'ports',
  'url', 'urls', 'http', 'https', 'json', 'jsonl', 'cron', 'oneshot', 'heartbeat', 'heartbeats', 'healthcheck', 'healthchecks', 'ping', 'pings',
  'repo', 'guardrail', 'guardrails', 'config', 'localhost', 'ssh', 'sudo', 'pid', 'uid', 'watchdog', 'module', 'modules', 'digest', 'stdout',
  'stderr', 'env', 'yaml', 'regex', 'schema', 'payload', 'latency', 'websocket', 'oauth', 'dns', 'tls', 'ssl', 'vlan', 'ufw', 'docker', 'container',
  'liveness', 'start-limit', 'harness', 'dispatcher', 'pacing line', 'pacing lines', 'model chain', 'dispatcher tick'];
const JARGON_RE = new RegExp('\\b(?:' + JARGON_WORDS.map(w => w.replace(/[-]/g, '[- ]?')).join('|') + ')\\b', 'gi');
const PATTERNS = [
  ['a code span', /`[^`]+`/g],
  ['a file path', /(?:~|\.{0,2})?\/?\b[\w.-]+\/[\w./-]+/g],
  ['a file or tool name', /\b[\w-]+\.(?:js|json|jsonl|md|py|sh|service|timer|socket|conf|ya?ml|txt|log|io)\b/g],
  ['an id', /\b[a-z]{1,4}-(?=[0-9a-f]*\d)[0-9a-f]{3,}\b/gi],
  ['a code', /\b[A-Z]{1,2}\d{1,3}\b/g],
  ['a clock time', /\b\d{1,2}:\d{2}(?::\d{2})?\b/g],
  ['a hash', /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g],
  ['a setting', /\b\w+=\S+/g],
  ['an identifier', /\b[a-z]+[A-Z][A-Za-z]+\b/g],
];
// what an owner card's plain parts must not carry beyond the patterns above (lib/owner-card.js)
const CARD_PATTERNS = [
  ['a model id', /\b(?:claude|gpt|o\d|minimax|gemini|llama|mistral|qwen|deepseek|sonnet|opus|haiku|abab)[-_.]?[\w.]*\d[\w.-]*\b/gi],
  ['a command', /(?:^|[\s(])(?:node|npm|npx|pip|git|sudo|systemctl|bash|sh|curl|wget|cd|ls|rm|mv|cp|chmod|docker|python3?)\s+[\w./~-]+/g],
  ['a command flag', /(?:^|\s)--?[a-z][\w-]*(?==|\s|$)/g],
  ['a clock spec', /\*\/\d+|\bOnCalendar\b|(?:^|\s)(?:[\d*]+\s+){4}[\d*]+(?:\s|$)|\bevery\s+\d+\s*(?:s|m|ms|min)\b/g],
  ['a setting name', /\b[a-z]+(?:_[a-z0-9]+)+\b/g],
  ['a diff', /^[+-]{3}\s|^@@\s/gm],
];
/* wordsProblems(text) -> the words of `text` a non-technical owner would not follow (empty = plain) */
function wordsProblems(text) {
  const t = String(text || '');
  const out = [];
  for (const m of t.match(JARGON_RE) || []) out.push(m);
  for (const [what, re] of PATTERNS.concat(CARD_PATTERNS)) for (const m of t.match(re) || []) out.push(String(m).trim() + ' (' + what + ')');
  return [...new Set(out)];
}
const MONEY = /\$\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:usd|eur|gbp|dollars?|euros?|pounds)\b/gi;
const GAIN = /\b(?:lets?|let us|unblocks?|unlocks?|enables?|opens? up|speeds? up|covers?|pays? for|buys? us|so (?:we|you|that|the|it)|gets?|gives?|means|saves?|costs?|risks?|protects?|allows?|helps?|keeps?|you(?:'ll| will| would| get| keep)|we(?:'ll| will| would| can| could)|in return|which (?:lets|means|gives)|to (?:test|start|try|reach|sell|launch|protect|keep|grow|earn|save|avoid|hire|pay|cover|run|finish|ship))\b/i;
const FALLBACK = /\b(?:if (?:you )?(?:skip|say no|decline|don't|do not|would rather not|pass|ignore|leave it|say not now|say later|wait)|if not\b|otherwise|without (?:it|this|that|one|them|your)|by default|default|until then|unless you|if you'd rather|if there(?:'s| is) no answer|no answer)/i;

function sentencesOf(t) { return String(t || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+(?=[A-Z("'`*\[])/).filter(Boolean); }
function syllables(w) { const s = w.toLowerCase().replace(/[^a-z]/g, ''); if (!s) return 0; const m = s.replace(/e$/, '').match(/[aeiouy]+/g); return Math.max(1, m ? m.length : 1); }

/* plainScore(text, opts) — a deterministic reading check of the owner's lead. opts.approval: the record states its
 * own default (deny), so the "if you skip it" clause is not needed in the text. */
function plainScore(text, opts) {
  opts = opts || {};
  const t = String(text || '').trim();
  const ss = sentencesOf(t);
  const wordsOf = s => s.split(/\s+/).filter(w => /[A-Za-z0-9]/.test(w));
  const counts = ss.map(s => wordsOf(s).length);
  const words = counts.reduce((a, b) => a + b, 0), longest = Math.max(0, ...counts);
  const jargon = [];
  for (const m of t.match(JARGON_RE) || []) jargon.push(m);
  for (const [what, re] of PATTERNS) for (const m of t.match(re) || []) jargon.push(m + ' (' + what + ')');
  const noMoney = t.replace(MONEY, ' ');
  const numbers = (noMoney.match(/\b\d[\d.,:]*\b/g) || []);
  // a money request states what the owner risks (the amount), and its sensible default is plain: nothing is spent
  const amount = new RegExp(MONEY.source, 'i').test(t);
  const moneyAsk = amount && /\b(?:may|can|could|shall|should) (?:i|we)\b[^?]*\b(?:spend|buy|pay|purchase|subscribe|upgrade)\b/i.test(t);
  const gain = amount || GAIN.test(t), fallback = !!opts.approval || moneyAsk || FALLBACK.test(t);
  const all = wordsOf(t); const syl = all.reduce((a, w) => a + syllables(w), 0);
  const ease = all.length ? 206.835 - 1.015 * (words / Math.max(1, ss.length)) - 84.6 * (syl / all.length) : 0;   // Flesch reading ease
  const problems = [];
  if (!t) problems.push('there is no message: write two plain sentences for the owner');
  if (ss.length > MAX_SENTENCES) problems.push('it has ' + ss.length + ' sentences; the owner gets at most ' + MAX_SENTENCES + ' short ones (move the rest under details)');
  if (longest > MAX_WORDS_PER_SENTENCE) problems.push('a sentence has ' + longest + ' words; keep each under ' + MAX_WORDS_PER_SENTENCE);
  if (t.length > MAX_CHARS) problems.push('it is ' + t.length + ' characters; keep it under ' + MAX_CHARS);
  if (jargon.length) problems.push('it uses words a non-technical owner would not know: ' + [...new Set(jargon)].slice(0, 8).join(', ') + ' (put technical detail under details)');
  if (numbers.length > MAX_NUMBERS) problems.push('it has ' + numbers.length + ' numbers (' + numbers.slice(0, 5).join(', ') + '); keep figures other than money under details');
  if (!gain) problems.push('it does not say what the owner gets or risks ("It lets us …", "It costs …", "It protects …")');
  if (!fallback) problems.push('it does not say what happens if they skip it ("If you skip it, we …"): give a sensible default');
  const score = Math.max(0, Math.round(100 - 12 * Math.max(0, ss.length - MAX_SENTENCES) - 2 * Math.max(0, longest - MAX_WORDS_PER_SENTENCE)
    - 10 * jargon.length - 5 * Math.max(0, numbers.length - MAX_NUMBERS) - (gain ? 0 : 15) - (fallback ? 0 : 15) - (ease < 30 ? 10 : 0)));
  if (!problems.length && score < MIN_SCORE) problems.push('it reads hard (score ' + score + ' of 100; ease ' + Math.round(ease) + '): shorter words and sentences');
  return { ok: problems.length === 0, score, sentences: ss.length, words, longest, ease: Math.round(ease), jargon, numbers, gain, fallback, problems };
}

/* suggestPlain(text, cls) — a plain version to start from: the owner topic's template, filled with what the text says */
function suggestPlain(text, cls) {
  const t = String(text || '');
  const owner = (cls && cls.owner) || [];
  const dom = t.match(/\b([a-z][a-z0-9-]+)\.(?:io|com|net|org|ai|dev|co)\b/i);
  const brand = dom ? dom[1].replace(/^./, c => c.toUpperCase()) : (t.match(/\b(?:a|an|one) (?:free )?([A-Z][\w]+) account\b/) || [])[1];
  const amount = (t.match(MONEY) || [])[0];
  if (owner.includes('account')) return 'Could you create a free ' + (brand || '<service>') + ' account in your name and paste what it gives you here? It lets us <what the owner gets, in everyday words>; if you skip it, <what the company does instead>.';
  if (owner.includes('money') || owner.includes('gate') && amount) return 'May we spend ' + (amount || '<amount>') + ' on <what, in everyday words>? It lets us <what the owner gets>; if you skip it, <what the company does instead>.';
  // keep the first sentence that already reads plainly, if there is one
  const first = sentencesOf(t).find(s => plainScore(s).jargon.length === 0 && s.split(/\s+/).length <= MAX_WORDS_PER_SENTENCE);
  return (first ? first.replace(/[.!]?$/, first.endsWith('?') ? '' : '?') : '<What you need from the owner, in everyday words>?') + ' It lets us <what the owner gets or avoids>; if you skip it, <what the company does instead>.';
}

/* routeFor(cls, from, seats) — where a crew-scope ask goes instead. seats: {risk, tools, floor} -> display name or null */
function routeFor(cls, from, seats) {
  seats = seats || {};
  const tally = {}; for (const c of (cls && cls.crew) || []) tally[c.seat] = (tally[c.seat] || 0) + 1;
  const order = Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([s]) => s);
  const to = order[0] || 'tools';
  const hands = [], lines = [];
  for (const s of order.length ? order : ['tools']) {
    if (s === 'framework') continue;
    const name = seats[s];
    if (name && from && String(name).toLowerCase() === String(from).toLowerCase()) lines.push('you hold the ' + s + ' seat, so it is yours');
    else hands.push(name ? name + ' (the ' + s + ' seat)' : 'the ' + s + ' seat');
  }
  if (hands.length) lines.push('hand it to ' + hands.join(' or ') + ' in a handoff');
  if (order.includes('framework')) lines.push('if it is a framework problem (a framework file, the house rules, a bug), file a framework request: node company/tools/harness-change.js propose --kind tool --target <file> --change <the diff> --why "…" --by ' + (from || '<you>'));
  return { to, line: 'Handle it yourself if your seat can; otherwise ' + lines.join('; ') + '.' };
}

/* the owner-only acts that have their own card with a button on Today: a crew ask that is really one of these is
 * pointed at the tool that files that card (never at a command the owner types) */
const OWNER_ACTS = [
  [/\b(?:accept|keep|sign[- ]?off)\b[^.]*\b(?:protected|locked|owner[- ]only|baseline|last[- ]known[- ]good)\b|\b(?:protected|locked|owner[- ]only) (?:file|tool|change)\b[^.]*\baccept|\baccept command\b|locked-watch(?:\.js)? accept/i,
    'to ask the owner to keep a protected file\'s change, file one card with an Accept button: node company/tools/locked-watch.js ask-accept <path> --by <you> --why "…" --plain "what it changes, in everyday words" [--if-no "…"] (someone other than the one who made the edit; never for a fixed-gate file, which goes back and through harness-change.js)'],
  [/\b(?:enable|switch(?:ing)? on|turn(?:ing)? on)\b[^.]*\b(?:module|add-on)\b|module\.js enable/i,
    'to ask the owner to switch a module on, file one card with a button: node company/tools/module.js ask <id> --by <you> --why "…"'],
  [/\binstall\b[^.]*\b(?:pack|capability pack|add-on)\b|pack\.js install/i,
    'a pack reaches the owner as one card with an Install button when you propose it (node company/tools/pack.js propose <dir> --by <you>), or when the CEO approves it'],
];
function ownerActHints(text) { return OWNER_ACTS.filter(([re]) => re.test(String(text || ''))).map(([, line]) => line); }

/* ---- dedupe / backoff ---- */
const STOP = new Set('that this with from have will would could should about there their they them what when your yours which into only also than then just been were more most some such each very much need needs want wants please skip skipped wait waits default otherwise happen happens owner instead nothing else change changes'.split(' '));
function topicWords(s) { return new Set(String(s || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).map(w => w.replace(/(?:ing|ed|es|s)$/, '')).filter(w => w.length >= 4 && !STOP.has(w))); }
function overlap(a, b) { if (!a.size || !b.size) return { n: 0, r: 0 }; let n = 0; for (const w of a) if (b.has(w)) n++; return { n, r: n / Math.min(a.size, b.size) }; }
const NOT_NOW = /^\s*(?:not now|not yet|no\b|later|skip|pass|don't|do not|declined?)|\bnot now\b/i;
function saidNotNow(row) {
  // the owner's own answer only: an expiry's default or a withdrawal's close is not the owner saying "not now"
  if (!row || row.surface === 'expiry' || row.closedBy || (row.answer && (row.answer.surface === 'expiry' || row.answer.withdrawn))) return false;
  if (row.by === 'expiry') return false;
  const v = row && row.answer && row.answer.verdict;
  if (v === 'no' || v === 'declined') return true;
  const txt = String((row && row.answer && (row.answer.value || row.answer.note)) || (row && row.a) || '');
  return NOT_NOW.test(txt);
}
/* backoff(o, rows, now) — the earlier ask on the same topic the owner answered "not now" within BACKOFF_DAYS, or null */
function backoff(o, rows, now) {
  now = now || Date.now();
  const asks = {}; for (const r of rows || []) if (r && r.type === 'ask') asks[r.id] = r;
  const about = String(o.about || '').trim().toLowerCase();
  const aboutWords = a => /^approval:/i.test(String(a || '')) ? '' : String(a || '');   // an approval's about is only its category
  const mine = topicWords(aboutWords(o.about) + ' ' + (o.message || o.q || ''));
  for (const r of (rows || []).slice().reverse()) {
    if (!r || r.type !== 'answer' || !asks[r.id]) continue;
    const at = Date.parse(r.at); if (!(now - at < BACKOFF_DAYS * 864e5) || !saidNotNow(r)) continue;
    const q = asks[r.id];
    const qa = String(q.about || '').trim().toLowerCase();
    const sameDigest = o.approvalDigest && q.approval && q.approval.actionDigest === o.approvalDigest;
    const sameAbout = about && qa && !/^approval:/.test(about) && about === qa;
    const sameRef = o.ref && q.gate && q.gate.ref && String(q.gate.ref) === String(o.ref);   // an owner card's dedupe key (lib/owner-card.js)
    const ov = overlap(mine, topicWords(aboutWords(q.about) + ' ' + (q.message || q.q || '')));
    if (sameDigest || sameAbout || sameRef || (ov.n >= 3 && ov.r >= 0.5)) return { id: q.id, at: r.at, answer: String(r.a || '').slice(0, 200) };
  }
  return null;
}

/* check(o, ctx) — the composer's owner-scope rule. o: {from, about, message, details, q, questions, category, level,
 * fixed, approvalDigest, changed}; ctx: {rows, now, seats}. null = may go to the owner. */
function check(o, ctx) {
  ctx = ctx || {};
  const lead = String(o.message || '').trim() || sentencesOf(String(o.q || '').split('\n')[0]).slice(0, 2).join(' ');
  const prompts = [lead].concat((o.questions || []).map(x => x && (x.prompt || x.message)).filter(Boolean));
  // a standing owner ruling (lib/owner-rulings.js): never for a fixed gate
  let ruling = null;
  if (!o.fixed) { try { ruling = require('./owner-rulings').match({ category: o.category, about: o.about, ref: o.ref, text: prompts.join(' ') }, Object.assign({}, ctx.govOpts || {}, ctx.rulings ? { rulings: ctx.rulings } : {})); } catch (_) { ruling = null; } }
  if (ruling && (ruling.effect === 'crew-decides' || ruling.effect === 'never-ask')) {
    return { code: 'ruling', ruling: { id: ruling.id, text: ruling.text, effect: ruling.effect }, route: ruling.effect === 'crew-decides' ? 'crew' : 'ruling',
      error: 'Not asked: the owner made a standing rule (' + ruling.id + ', ' + String(ruling.at || '').slice(0, 10) + '): "' + ruling.text + '". ' +
        (ruling.effect === 'crew-decides' ? 'The crew decides this itself; do it within the company\'s limits and record it as usual.' : 'The owner does not want to be asked about this: the default (no) stands.') };
  }
  const cls = classify(Object.assign({}, o, { message: prompts.join(' '), ownerAsks: !!(ruling && ruling.effect === 'ask') }), ctx);
  if (cls.route === 'crew' || cls.route === 'digest') {
    return { code: 'crew-scope', classification: cls, route: cls.route, level: cls.level,
      error: 'Not asked: ' + cls.why + '. The owner set that level themselves, so this is not their decision: the accountable seat decides and records it' +
        (cls.route === 'digest' ? ' (the owner reads it in the daily digest, not as a question).' : '.') };
  }
  const WHO = 'The owner is a busy non-technical person, asked only for: money beyond the company\'s own limits; accounts or identity in their own name (a sign-up, a sign-in, a key only they can get); legal, ownership or commitment decisions; company direction and priorities; risk the governance level reserves for them; the fixed gates.';
  if (cls.scope === 'crew') {
    const r = routeFor(cls, o.from, ctx.seats);
    const acts = ownerActHints([lead, o.details, o.q].filter(Boolean).join('\n'));
    return { code: 'crew-scope', classification: cls, route: r.to, ownerActs: acts.length ? acts : undefined, error: 'Not asked: this is the crew\'s job, not the owner\'s — ' + cls.why + '. ' + WHO + ' ' + r.line +
      (acts.length ? ' If it truly is the owner\'s own act: ' + acts.join('; ') + '.' : '') +
      ' If it truly needs something only the owner has (money, or an account in their name), ask only that, in two plain sentences with a default, e.g. "' + suggestPlain(lead, { owner: ['account'] }) + '"' };
  }
  const prior = backoff(Object.assign({}, o, { message: lead }), ctx.rows, ctx.now);
  if (prior && String(o.changed || '').trim().length < 15) {
    return { code: 'backoff', classification: cls, prior, error: 'Not asked: the owner answered the same topic "not now" on ' + String(prior.at).slice(0, 10) + ' (' + prior.id + ': "' + prior.answer + '"). Do not ask again for ' + BACKOFF_DAYS + ' days unless something material changed; if it did, ask again with --changed "<what is different now>".' };
  }
  for (const p of prompts) {
    const s = plainScore(p, { approval: !!o.category });
    if (!s.ok) {
      const crewBits = cls.crew.length ? ' The technical part (' + [...new Set(cls.crew.map(c => c.hit))].slice(0, 5).join(', ') + ') is the crew\'s: ' + routeFor(cls, o.from, ctx.seats).line : '';
      const suggestion = suggestPlain(p, cls);
      return { code: 'plain', classification: cls, score: s, suggestion, error: 'Not asked: the owner would not follow this. ' + s.problems.join('; ') + '.' + crewBits +
        ' The owner gets two short sentences: what you need, what they get or risk, and what happens if they skip it; everything technical goes under details. Try: "' + suggestion + '"' };
    }
  }
  return null;
}

module.exports = { ownerActHints, classify, plainScore, suggestPlain, routeFor, backoff, saidNotNow, check, wordsProblems, BACKOFF_DAYS, JARGON_WORDS };
