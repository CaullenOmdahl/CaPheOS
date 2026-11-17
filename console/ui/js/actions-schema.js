// Chat actions (docs/CHAT-ACTIONS.md): the schema of an ```actions block an agent writes in a chat reply, and the reply
// line a click sends back. Pure data, no DOM, so the console (md.js, chat-actions.js), console/chat.js and the tests
// share one definition.
//
// A block is JSON: {"id", "prompt"?, "items": [...]}. Item types: button (label, value, tone primary|danger), choice,
// text, url, slider, link (label, href: console:#/… or https://…; another scheme keeps only the label), secret (label,
// name under secrets/), approval (ref: an EXISTING owner approval's question id, answered through the approval API;
// never minted here). Anything else (another type, a secret name the console may not write) makes the whole block
// invalid, and
// md.js shows it as plain text with a note. A block has no way to say "run this": there is no command or run type, every
// reply-type item only sends a message into the chat, a link only navigates (console:#/… or a web page, never a
// terminal), a secret only goes to the key store. And no item may CARRY a shell command for the owner either: a value,
// option, label, prompt, help or placeholder that is a command line (systemctl …, sudo …, npm/pip install …, git push …,
// node company/tools/…, a $ prompt, a chained `a && b`) or holds one in backticks makes the block invalid (shellValue).
// The owner works only in the console; an agent that needs a command run routes it (console action, approval, handoff).
//
// The reply is the owner's next message: a visible line ("Chose: Ship today", "Set: Share 80%", "Stored example-key
// (40 chars)") and, on the last line, `[actionReply {"id":…,"value":…,"fields":{…}}]` for the agent to read.

export const MAX_AGE_HOURS = 24;   // an unanswered block older than this renders expired
export const REPLY_TYPES = ['button', 'choice', 'text', 'url', 'slider', 'secret'];
export const ITEM_TYPES = REPLY_TYPES.concat(['link', 'approval']);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const SECRET_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;   // as company/tools/inbox.js safeSecretName
const RESERVED = new Set(['readme.md', 'station-token', 'console-token']);
export const safeSecretName = n => SECRET_NAME.test(String(n || '')) && !RESERVED.has(String(n).toLowerCase()) && !String(n).includes('..');
export const safeActionHref = u => { const s = String(u || '').trim(); return /^console:?#\//i.test(s) || /^#\//.test(s) || /^https?:\/\/[^\s<>"]+$/i.test(s); };

// a shell command line the owner would have to type: the structural check every text in a block passes (shellValue)
const CMD_WORDS = 'sudo|systemctl|journalctl|loginctl|npm|npx|pnpm|yarn|pip3?|pipx|apt(?:-get)?|dnf|pacman|brew|git|node|bash|sh|zsh|docker|podman|curl|wget|python3?|chmod|chown|rm|mv|cp|kill|pkill|crontab|ssh|scp|make|patch';
const CMD_LINE = new RegExp('^\\s*(?:\\$\\s*)?(?:' + CMD_WORDS + ')(?:\\s+\\S.*)?$', 'i');
const CMD_TICK = new RegExp('`\\s*(?:\\$\\s*)?(?:' + CMD_WORDS + ')\\s+[^`]*`', 'i');
const CMD_INLINE = /\bsudo\s+\S+|\bsystemctl\s+(?:--user\s+)?[a-z-]+|\b(?:npm|pnpm|yarn)\s+(?:i|install|ci|run|exec)\b|\bpip3?\s+install\b|\bgit\s+(?:push|pull|reset|checkout|commit|merge|rebase|clone|apply)\b|\bnode\s+\S+\.js\b|&&|\|\s*(?:sh|bash)\b/i;
/* shellValue(text, {value}) -> the command it carries, or null. A value (what a click sends) counts when it is a command
   line at all; prose (a label, the prompt) when it holds a backticked command or an inline one (sudo …, systemctl …). */
export function shellValue(v, opts) {
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = v.trim();
  // a value: a command word with flags or a path after it ("rm -rf x", "node company/tools/a.js"), or an inline command
  if (opts && opts.value && CMD_LINE.test(t) && /\s(?:-{1,2}\w|\S*[\/.]\S)/.test(t)) return t.slice(0, 80);
  const m = CMD_TICK.exec(t) || CMD_INLINE.exec(t);
  return m ? m[0].replace(/`/g, '').trim().slice(0, 80) : null;
}

const str = (v, max) => typeof v === 'string' && v.trim() !== '' && v.length <= max;
const num = v => typeof v === 'number' && isFinite(v);

/* parseActions(raw JSON text) -> { ok: true, block } | { ok: false, error }. The block returned is rebuilt from the
   known keys only (anything else the agent wrote is dropped), so nothing unexpected reaches the renderer. */
export function parseActions(raw) {
  let j;
  try { j = JSON.parse(String(raw == null ? '' : raw)); } catch (e) { return { ok: false, error: 'not JSON' }; }
  try { return { ok: true, block: check(j) }; } catch (e) { return { ok: false, error: e.message }; }
}
function check(j) {
  const no = m => { throw new Error(m); };
  if (!j || typeof j !== 'object' || Array.isArray(j)) no('a block is a JSON object');
  if (!ID.test(String(j.id || ''))) no('id: letters, digits, . _ : - (at most 64)');
  if (j.prompt !== undefined && !str(j.prompt, 600)) no('prompt: text up to 600 characters');
  if (!Array.isArray(j.items) || !j.items.length || j.items.length > 12) no('items: 1 to 12');
  const ids = new Set(); const out = { id: j.id, prompt: j.prompt ? j.prompt.trim() : '', items: [] };
  j.items.forEach((it, n) => {
    const at = 'item ' + (n + 1) + ': ';
    if (!it || typeof it !== 'object') no(at + 'not an object');
    const t = it.type || (it.value !== undefined ? 'button' : it.href !== undefined ? 'link' : '');
    if (!ITEM_TYPES.includes(t)) no(at + 'type must be one of ' + ITEM_TYPES.join(', '));
    if (t === 'approval') {
      // an EXISTING owner approval (company/tools/approvals.js), by its question id; the block never creates one, and
      // what it may do (answer here, or only on Needs you) is the server's to say
      if (!/^q-\d{1,9}$/.test(String(it.ref || ''))) no(at + 'ref: the approval\'s question id (q-123456)');
      if (it.label !== undefined && !str(it.label, 80)) no(at + 'label: text up to 80 characters');
      out.items.push({ type: t, ref: it.ref, label: it.label ? it.label.trim() : '' }); return;
    }
    if (!str(it.label, 80)) no(at + 'label: text up to 80 characters');
    const o = { type: t, label: it.label.trim() };
    if (t === 'button') {
      if (!(str(it.value, 200) || num(it.value) || typeof it.value === 'boolean')) no(at + 'value: text up to 200 characters, a number or true/false');
      o.value = it.value;
      if (it.tone !== undefined) { if (!['primary', 'danger', 'default'].includes(it.tone)) no(at + 'tone: primary or danger'); o.tone = it.tone; }
    } else if (t === 'link') {
      // as md.js links: console:#/… and https:// only; any other scheme is dropped and only the label is kept
      if (typeof it.href !== 'string' || it.href.length > 2000) no(at + 'href: console:#/… or https://…');
      o.href = safeActionHref(it.href) ? it.href.trim() : null;
    } else {
      // a field: its id names its value in the reply
      if (!ID.test(String(it.id || ''))) no(at + 'id: letters, digits, . _ : -');
      if (ids.has(it.id)) no(at + 'two fields with id ' + it.id); ids.add(it.id);
      o.id = it.id;
      if (it.help !== undefined) { if (!str(it.help, 300)) no(at + 'help: text up to 300 characters'); o.help = it.help; }
      if (t === 'choice') {
        if (!Array.isArray(it.options) || it.options.length < 2 || it.options.length > 12) no(at + 'options: 2 to 12');
        const seen = new Set();
        o.options = it.options.map((op, k) => {
          const x = typeof op === 'string' ? { id: op, label: op } : op || {};
          const oid = x.id !== undefined ? String(x.id) : x.value !== undefined ? String(x.value) : '';
          if (!str(oid, 100) || seen.has(oid)) no(at + 'option ' + (k + 1) + ': an id (unique, up to 100 characters)'); seen.add(oid);
          if (!str(x.label || oid, 80)) no(at + 'option ' + (k + 1) + ': label up to 80 characters');
          return { id: oid, label: String(x.label || oid).trim(), recommended: x.recommended === true };
        });
      } else if (t === 'text' || t === 'url') {
        if (it.placeholder !== undefined) { if (!str(it.placeholder, 120)) no(at + 'placeholder: up to 120 characters'); o.placeholder = it.placeholder; }
        o.maxLength = Math.min(500, Number(it.maxLength) > 0 ? Math.floor(Number(it.maxLength)) : 500);
      } else if (t === 'slider') {
        for (const k of ['min', 'max']) if (!num(it[k])) no(at + k + ': a number');
        if (!(it.max > it.min)) no(at + 'max must be above min');
        const step = it.step === undefined ? 1 : it.step; if (!num(step) || step <= 0 || (it.max - it.min) / step > 10000) no(at + 'step: a positive number');
        Object.assign(o, { min: it.min, max: it.max, step, value: num(it.value) ? Math.min(it.max, Math.max(it.min, it.value)) : it.min });
        if (it.unit !== undefined) { if (!str(it.unit, 12)) no(at + 'unit: up to 12 characters'); o.unit = it.unit; }
        for (const k of ['minLabel', 'maxLabel']) if (it[k] !== undefined) { if (!str(it[k], 40)) no(at + k + ': up to 40 characters'); o[k] = it[k]; }
      } else if (t === 'secret') {
        if (!safeSecretName(it.name)) no(at + 'name: a file name under secrets/ (letters, digits, . _ -; not station-token or console-token)');
        o.name = it.name;
        if (it.provider !== undefined) { if (!str(it.provider, 300)) no(at + 'provider: up to 300 characters'); o.provider = it.provider; }
      }
    }
    out.items.push(o);
  });
  // nothing in the block hands the owner a command (see the header): checked on what the renderer would show or send
  const cmd = (v, where, value) => { const c = shellValue(v, { value }); if (c) no(where + ': a command for the owner ("' + c + '"). The owner never runs commands: link the console action that does it, ask for an approval, or hand it to the tools seat'); };
  cmd(out.prompt, 'prompt');
  out.items.forEach((o, n) => {
    const at = 'item ' + (n + 1);
    cmd(o.label, at + ' label'); cmd(o.help, at + ' help'); cmd(o.placeholder, at + ' placeholder');
    if (typeof o.value === 'string') cmd(o.value, at + ' value', true);
    for (const op of o.options || []) { cmd(op.id, at + ' option', true); cmd(op.label, at + ' option label'); }
  });
  const kinds = out.items.map(i => i.type);
  // a key is stored and answered on its own: a secret shares its block with links only, never with other answers
  if (kinds.includes('secret') && kinds.filter(k => k !== 'link').length > 1) no('a secret field goes in a block of its own (links are fine)');
  if (kinds.includes('approval') && kinds.some(k => k !== 'link' && k !== 'approval')) no('approvals go in a block of their own (links are fine)');
  return out;
}

/* the blocks in an agent's message: [{ raw, start, end }] (fences that say ```actions) */
export function findBlocks(text) {
  const out = []; const lines = String(text || '').replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*```\s*actions\s*$/i.test(lines[i])) continue;
    const buf = []; let j = i + 1;
    while (j < lines.length && !/^\s*```\s*$/.test(lines[j])) buf.push(lines[j++]);
    out.push({ raw: buf.join('\n'), closed: j < lines.length });
    i = j;
  }
  return out;
}

/* ---------- the reply ---------- */
const LINE = /^\[actionReply (\{.*\})\]\s*$/;
const fmt = (f, v) => f.type === 'slider' ? String(v) + (f.unit ? (/^[%°]/.test(f.unit) ? '' : ' ') + f.unit : '')
  : f.type === 'choice' ? ((f.options || []).find(o => o.id === v) || { label: v }).label : String(v);

/* replyFor(block, {button?, fields: {id: value}, stored?}) -> { text, shown, reply }. text is what goes into the chat
   (the visible line, then the machine line); shown is the visible line alone. A secret never has a value here: only
   {stored, chars} from the key store. */
export function replyFor(block, pick) {
  const fields = {}; const said = [];
  for (const f of block.items) {
    if (f.type === 'secret' || f.type === 'button' || f.type === 'link') continue;
    const v = pick.fields ? pick.fields[f.id] : undefined;
    if (v === undefined || v === '' || v === null) continue;
    fields[f.id] = v; said.push((f.label ? f.label + ' ' : '') + fmt(f, v));
  }
  const reply = { id: block.id };
  let shown;
  if (pick.stored) {
    reply.stored = { name: pick.stored.name, chars: pick.stored.chars };
    shown = 'Stored ' + pick.stored.name + ' (' + pick.stored.chars + ' chars)';
  } else if (pick.button) {
    reply.value = pick.button.value;
    shown = 'Chose: ' + pick.button.label + (said.length ? ' · ' + said.join(', ') : '');
  } else shown = 'Set: ' + (said.join(', ') || 'nothing');
  if (Object.keys(fields).length) reply.fields = fields;
  shown = shown.replace(/\s+/g, ' ').slice(0, 300);
  return { text: shown + '\n[actionReply ' + JSON.stringify(reply) + ']', shown, reply };
}

/* parseActionReply(message text) -> { reply, shown } | null: the owner's message is a reply to an actions block.
   Used by the console (lock a block on replay) and by console/chat.js (the agent's context note). */
export function parseActionReply(text) {
  const lines = String(text || '').replace(/\r/g, '').replace(/\s+$/, '').split('\n');
  const m = LINE.exec(lines[lines.length - 1] || ''); if (!m) return null;
  let r; try { r = JSON.parse(m[1]); } catch (_) { return null; }
  if (!r || typeof r !== 'object' || !ID.test(String(r.id || ''))) return null;
  return { reply: r, shown: lines.slice(0, -1).join('\n').trim() };
}
/* the owner's message without its machine line (what the bubble shows) */
export function stripReplyLine(text) { const p = parseActionReply(text); return p ? p.shown : String(text == null ? '' : text); }

/* blockStates(turns) -> Map<turnIndex, Map<blockId, {answered?: {shown, reply}, superseded?: true}>> for a chat
   transcript [{role, content, at}]: a block is answered by the first owner reply with its id after it, superseded by a
   later block with the same id. */
export function blockStates(turns) {
  const out = new Map(); const last = {};
  (turns || []).forEach((t, i) => {
    if (t.role === 'assistant') for (const b of findBlocks(t.content)) { const p = parseActions(b.raw); if (p.ok) { last[p.block.id] = i; (out.get(i) || out.set(i, new Map()).get(i)).set(p.block.id, {}); } }
  });
  (turns || []).forEach((t, i) => {
    if (t.role !== 'user') return; const p = parseActionReply(t.content); if (!p) return;
    // the latest block with this id before the reply
    let k = -1; for (const [ti, m] of out) if (ti < i && m.has(p.reply.id) && !m.get(p.reply.id).answered) k = Math.max(k, ti);
    if (k >= 0) out.get(k).get(p.reply.id).answered = p;
  });
  for (const [ti, m] of out) for (const [id, s] of m) if (last[id] > ti && !s.answered) s.superseded = true;
  return out;
}
export const isStale = (at, now) => !!at && (now || Date.now()) - Date.parse(at) > MAX_AGE_HOURS * 3600e3;
