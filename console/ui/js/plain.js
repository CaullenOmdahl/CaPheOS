// Plain words for the owner: the console's raw ids, tags and numbers turned into what a person reads. Pure, no DOM
// (tested by company/tools/tests/console-plain.test.js). Raw ids stay available to callers for a Details disclosure.

// a question's human category: one of Access, Money, Hiring, AI usage, Setup, or none (''). Only structured sources
// are trusted (a governance gate's category, a "governance:"/"pacing:" tag, the form's field kinds, a request's own
// questions); a free-text `about` tag is not ("commitments module" once read as "Commitment" on an access request).
const CATS = [
  [/hir|candidate|interview|recruit/i, 'Hiring'],
  [/pac|usage|\bclaude\b|minimax|deepseek|\bmodels?\b|subscription/i, 'AI usage'],
  [/access|\bkey\b|secret|account|credential|login|sign.?up|password|token|\burl\b|address/i, 'Access'],
  [/budget|money|spend|cost|\$\d|price|\bfees?\b|\bcap\b|finance|invoice|paid plan/i, 'Money'],
  [/onboard|setup|charter/i, 'Setup'],
];
const catOf = src => { for (const [re, label] of CATS) if (re.test(src)) return label; return ''; };
const fieldCat = form => { const kinds = form && Array.isArray(form.fields) ? form.fields.map(f => f.type) : []; return kinds.includes('secret') || kinds.includes('url') ? 'Access' : ''; };
export function category(q) {
  q = q || {};
  const tag = String(q.about || '');
  const structured = [q.gate && q.gate.category, /^(governance|pacing):/.test(tag) ? tag.replace(/^governance:/, '') : ''].filter(Boolean).join(' ');
  if (structured) { const c = catOf(structured); if (c) return c; }
  if (Array.isArray(q.questions) && q.questions.length) {
    // a request: the category its questions share, else none (the "N questions" tag says enough)
    const cats = q.questions.map(p => fieldCat(p.form) || catOf(String(p.prompt || '')) || 'general');
    return cats.every(c => c === cats[0]) && cats[0] !== 'general' ? cats[0] : '';
  }
  const c = fieldCat(q.form) || (q.secretHint ? 'Access' : '') || catOf(tag.length <= 24 ? tag : '');
  if (c) return c;
  return q.blocking ? 'Blocking' : '';
}
// a request's one-line lead: the asker's first sentence, at most `max` characters (cut at a word, with …)
export function leadLine(text, max) {
  max = max || 160;
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const first = t.split(/(?<=[.!?])\s+(?=[A-Z("'`*\[])/)[0] || '';
  if (first.length <= max) return first;
  return first.slice(0, max - 1).replace(/[\s,;:]+\S*$/, '') + '…';
}

// a display name with each word capitalised ("Nadia farrell" -> "Nadia Farrell", "NADIA FARRELL" -> "Nadia Farrell");
// a word already mixed-case ("McDonald") is left alone. Display only: the roster is not renamed.
export function personName(n) {
  const s = String(n == null ? '' : n).trim();
  if (!s || /^[a-z0-9]+(-[a-z0-9]+){2,}$/.test(s)) return s;   // an id, not a name
  return s.split(/(\s+|-)/).map(w => {
    if (!/^[A-Za-z]/.test(w)) return w;
    if (w === w.toUpperCase() && w.length > 1) return w.charAt(0) + w.slice(1).toLowerCase();
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join('');
}
// "cand-people-manager-1-tobias-lin" -> "Tobias Lin" (the slug after the round's number), when no name is known
export function nameFromId(id) {
  const m = /^cand-.*?-\d+-([a-z][a-z-]*)$/.exec(String(id || ''));
  return m ? personName(m[1].replace(/-+$/, '').replace(/-/g, ' ')) : String(id || '');
}

const r1 = n => Math.round(Number(n) * 10) / 10;
// one subscription's usage, in the owner's words: "78% of this week used" / "today's allowance 90%", and why it is
// open or paused ("open because you lifted today's limit until 02:14")
export function usageLine(p, em, fmt) {
  fmt = fmt || (t => new Date(t).toTimeString().slice(0, 5));
  const name = p.label || p.key || 'Subscription';
  const known = !!p.known && p.usedPct != null;
  const used = known ? Number(p.usedPct) : null, line = p.line != null ? Number(p.line) : null;
  const fiveHour = p.paceBy === 'fiveHour';
  const reading = known ? r1(used) + '% of this week used' + (line != null && !fiveHour ? '; today\'s allowance ' + r1(line) + '%' : '') : 'no reading yet';
  let note;
  if (!known) note = 'The pacer has no reading for ' + name + ' yet.';
  else if (fiveHour) note = p.open === false ? 'Paused for routines this week.' : 'Open: paced by its own 5-hour window' + (p.fiveHourLeftPct != null ? ' (' + r1(p.fiveHourLeftPct) + '% of it left)' : '') + '.';
  else if (p.open === false) note = p.hard ? 'Paused for routines for now.' : 'Paused for routines: today\'s allowance is used up.';
  else if (p.emergencyOpened && em && em.active) note = 'Open because you lifted today\'s limit' + (em.until ? ' until ' + fmt(em.until) : '') + '.';
  else if (line != null) note = 'Open: ' + r1(Math.max(0, line - used)) + ' points left today.';
  else note = 'Open.';
  return { name, reading, note, pct: known ? Math.max(0, Math.min(100, Math.round(used))) : 0, mark: line != null && !fiveHour ? Math.max(0, Math.min(100, line)) : null,
    over: known && line != null && !fiveHour && used > line, aria: name + ': ' + reading };
}
// the station's daily spend limit across every provider: "Station-wide limit: $3 of $25 today"
export function railLine(rail) {
  if (!rail || rail.none || !(rail.perDay > 0)) return null;
  const spent = Number(rail.pct || 0) * rail.perDay / 100;
  const money = v => '$' + (v >= 10 || Math.abs(v - Math.round(v)) < 0.05 ? Math.round(v) : v.toFixed(2));
  return { name: 'Station-wide limit', reading: money(spent) + ' of ' + money(rail.perDay) + ' today', pct: Math.min(100, Math.round(rail.pct || 0)), over: !!rail.pressure,
    note: rail.pressure ? 'Near the limit: pay-per-token runs are being held.' : 'Every pay-per-token provider together.' };
}

// Sprint, plain: "Sprint on until 14:22 tomorrow · 56 things done · $0.53 of $10 spent"; the rest for a Details popover
export function sprintSummary(sp, when) {
  const money = v => '$' + (Number(v) >= 10 || Number.isInteger(Number(v)) ? Math.round(Number(v)) : Number(v).toFixed(2));
  const head = 'Sprint on ' + (sp.until ? 'until ' + when(sp.until) : sp.untilWhy && /certified/.test(sp.untilWhy) ? 'until setup is finished, then a day more' : 'until you turn it off');
  const line = [head, (sp.itemsDone || 0) + (sp.itemsDone === 1 ? ' thing' : ' things') + ' done', money(sp.spentUsd || 0) + ' of ' + money(sp.budgetUsd || 0) + ' spent'].join(' · ');
  const details = [
    sp.wakes != null ? sp.wakes + ' wake-ups' + (sp.idleWakeRatio != null ? ', ' + Math.round(sp.idleWakeRatio * 100) + '% of them found nothing to do' : '') : null,
    sp.usdPerItem != null ? '$' + Number(sp.usdPerItem).toFixed(3) + ' per thing done' : null,
    sp.proposalsPerHour != null ? sp.proposalsPerHour + ' proposals an hour against ' + sp.reviewsPerHour + ' reviews an hour' : null,
  ].filter(Boolean);
  return { line, details };
}

// a seat's status word and line, the same on Today and Crew, from the dispatcher's reason (seat-status.js states)
const STATE_WORD = { working: 'Working', started: 'Working', 'held-money': 'Paused', waiting: 'Waiting', stuck: 'Stuck', resting: 'Resting', held: 'Held', idle: 'Idle' };
export function seatState({ run, seat, station, stationDown, isCeo }) {
  const nx = seat || {};
  const running = run ? Math.max(1, nx.running || 1) : 0;
  let word, line = '';
  if (run) word = 'Working';
  else if (nx.idle && nx.idle.state && STATE_WORD[nx.idle.state] && !(nx.idle.state === 'working' || nx.idle.state === 'started')) { word = STATE_WORD[nx.idle.state]; line = nx.idle.reason || ''; }
  else if (stationDown) word = 'Unknown';
  else { const s = String((station && (station.status || station.state)) || '').toLowerCase(); word = s && !/^(working|busy|running)$/.test(s) ? s.charAt(0).toUpperCase() + s.slice(1) : 'Idle'; }
  if (word === 'Idle' && !line && nx.idle && nx.idle.reason && !/^(working|started)/.test(nx.idle.reason)) line = nx.idle.reason;
  // parallel work: only while a seat really has more than one run going, and never for the CEO (it gets no lanes)
  const live = nx.lanes && Array.isArray(nx.lanes.live) ? nx.lanes.live.length : 0;
  const n = Math.max(running, live);
  const lanes = !isCeo && run && n >= 2 ? 'Working on ' + n + ' things at once' : '';
  return { word, line: line ? line.charAt(0).toUpperCase() + line.slice(1) : '', lanes };
}

// Spend › By seat: the crew one row each; interview candidates (not in the crew) folded into one row
export function groupSeats(rows, crewIds) {
  const crew = new Set(crewIds || []);
  const seats = [], cands = [];
  for (const r of rows || []) {
    const isCand = r.candidate === true || (r.candidate !== false && !crew.has(r.id) && /^cand-/.test(String(r.id || '')));
    const name = r.name && r.name !== r.id ? personName(r.name) : nameFromId(r.id);
    (isCand ? cands : seats).push(Object.assign({}, r, { name }));
  }
  const usd = Math.round(cands.reduce((a, r) => a + (Number(r.usd) || 0), 0) * 10000) / 10000;
  return { seats, candidates: cands.length ? { n: cands.length, usd, rows: cands } : null };
}

// One time format everywhere: 24 h in the company timezone, with a relative day: "today 14:22", "tomorrow 14:22",
// "Nov 17 03:25" (another day; the year only when it is not this year). `now` is for tests.
export function whenText(t, tz, now) {
  const ms = typeof t === 'number' ? t : Date.parse(t); if (!ms || isNaN(ms)) return '';
  const parts = x => { const o = {}; try { for (const p of new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(x)) o[p.type] = p.value; } catch (_) { const d = new Date(x); return { key: d.toDateString(), year: String(d.getFullYear()), month: d.toDateString().slice(4, 7), day: String(d.getDate()), hm: d.toTimeString().slice(0, 5) }; }
    return { key: o.year + '-' + o.month + '-' + o.day, year: o.year, month: o.month, day: o.day, hm: (o.hour === '24' ? '00' : o.hour) + ':' + o.minute }; };
  const n = now == null ? Date.now() : now;
  const a = parts(ms), today = parts(n), tomorrow = parts(n + 86400e3);
  if (a.key === today.key) return 'today ' + a.hm;
  if (a.key === tomorrow.key) return 'tomorrow ' + a.hm;
  return a.month + ' ' + a.day + (a.year !== today.year ? ' ' + a.year : '') + ' ' + a.hm;
}

// a model in plain words: "deepseek/deepseek-flash" -> "DeepSeek Flash", "claude-cli/claude-sonnet-5-5" -> "Claude Sonnet 5.5",
// "minimax/MiniMax-M2" -> "MiniMax M2". Raw ids stay for a Details disclosure.
const BRAND = { deepseek: 'DeepSeek', minimax: 'MiniMax', claude: 'Claude', 'claude-cli': 'Claude', openai: 'OpenAI', gpt: 'GPT', gemini: 'Gemini', anthropic: 'Anthropic', ollama: 'Ollama', qwen: 'Qwen', kimi: 'Kimi', glm: 'GLM' };
export function providerName(p) { const s = String(p || '').trim(); return BRAND[s.toLowerCase()] || (s ? s.charAt(0).toUpperCase() + s.slice(1) : ''); }
export function modelName(id, provider) {
  let s = String(id || '').trim(); if (!s) return '';
  if (s.includes('/')) { const [pv, rest] = [s.slice(0, s.indexOf('/')), s.slice(s.indexOf('/') + 1)]; provider = provider || pv; s = rest; }
  const words = s.split(/[-_\s]+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i], lw = w.toLowerCase();
    // version runs: "5-5" -> "5.5", "4-1" -> "4.1"
    if (/^\d+$/.test(w) && out.length && /^\d+(\.\d+)*$/.test(out[out.length - 1])) { out[out.length - 1] += '.' + w; continue; }
    if (BRAND[lw]) { out.push(BRAND[lw]); continue; }
    if (/^[a-z]\d/i.test(w)) { out.push(w.toUpperCase()); continue; }   // m2 -> M2, v3 -> V3
    out.push(/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1));
  }
  let name = out.join(' ');
  const brand = providerName(provider);
  if (brand && !name.toLowerCase().startsWith(brand.toLowerCase()) && /^(flash|chat|reasoner|pro|lite|mini|turbo)\b/i.test(name)) name = brand + ' ' + name;
  return name;
}
// "Runs on DeepSeek" / "Runs on Claude" for a chat header or crew card
export function runsOn(provider, model) { const b = providerName(provider) || (model ? modelName(model).split(' ')[0] : ''); return b ? 'Runs on ' + b : ''; }
