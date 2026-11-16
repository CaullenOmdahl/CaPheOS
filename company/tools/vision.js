#!/usr/bin/env node
/* vision.js — look at an image with DeepSeek V4.1 Flash, on the company's DeepSeek key. Never OpenRouter.
 *
 * Why: StarNet's own image_analyze tool tries the station's OpenRouter key first and only falls back to the agent's
 * provider. The owner wants DeepSeek used, not OpenRouter, and DeepSeek's deepseek-flash accepts images
 * (https://api-docs.deepseek.com/guides/vision/). So agents check images with this instead of image_analyze.
 *
 *   node company/tools/vision.js <image.png|jpg|webp|gif> "<question>" [--by <name>] [--detail low|high]
 *
 * Prints JSON { ok, answer }. It runs Flash the way the agents do (thinking on, effort high) with room to think and
 * answer. No cost tracking here. The key comes from secrets/deepseek-key (co.secret), falling back to the station's
 * provider-key store under .starnet-data/, and is never printed.
 * Ask closed, checkable questions ("Is any figure wearing a helmet? yes/no, which frame?") and never treat the answer as
 * the only check: the pixel checks in station-art.js still decide.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const co = require('./lib/company');
const ROOT = co.ROOT;
const KEYS = co.p('.starnet-data', 'workspaces', '.secrets', 'provider-keys.json');
const out = (code, o) => { console.log(JSON.stringify(o, null, 1)); process.exit(code); };

(async () => {
  const a = process.argv.slice(2);
  const opt = k => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : null; };
  const pos = a.filter((x, i) => !x.startsWith('--') && !(i > 0 && a[i - 1].startsWith('--')));
  const [img, question] = pos;
  if (!img || !question) out(2, { ok: false, error: 'usage: vision.js <image> "<question>" [--by <name>] [--detail low|high]' });
  const file = path.resolve(ROOT, img);
  if (!fs.existsSync(file)) out(2, { ok: false, error: 'no such image: ' + img });
  const buf = fs.readFileSync(file);
  if (buf.length > 30 * 1024 * 1024) out(2, { ok: false, error: 'image over 30 MB' });
  const sig = buf.slice(0, 12).toString('hex');
  const mime = sig.startsWith('89504e47') ? 'image/png' : sig.startsWith('ffd8') ? 'image/jpeg' : sig.startsWith('47494638') ? 'image/gif' : sig.includes('57454250') ? 'image/webp' : null;
  if (!mime) out(2, { ok: false, error: 'not a PNG, JPEG, GIF or WebP image' });
  let key = co.secret('deepseek-key') || '';
  if (!key) try { const d = JSON.parse(fs.readFileSync(KEYS, 'utf8')); key = ((d.providers || d).deepseek || {}).key || ''; } catch (_) {}
  if (!key) out(3, { ok: false, error: 'no DeepSeek key: put it in secrets/deepseek-key (or the station provider-key store)' });
  const detail = ['low', 'high', 'auto', 'original'].includes(opt('detail')) ? opt('detail') : 'high';
  // same settings as the agents: thinking on at high effort, with plenty of room for the thinking and the answer
  const body = { model: 'deepseek-flash', max_tokens: 64000, reasoning_effort: 'high', messages: [{ role: 'user', content: [
    { type: 'text', text: String(question) },
    { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + buf.toString('base64'), detail } },
  ] }] };
  let r, j;
  try {
    r = await fetch('https://api.deepseek.com/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify(body), signal: AbortSignal.timeout(600000) });
    j = await r.json().catch(() => ({}));
  } catch (e) { out(1, { ok: false, error: 'DeepSeek request failed: ' + e.message }); }
  if (!r.ok) out(1, { ok: false, error: 'DeepSeek HTTP ' + r.status + ': ' + JSON.stringify(j).slice(0, 300).replace(key, '<key>') });
  const msg = (((j.choices || [])[0] || {}).message || {});
  const answer = msg.content || '';
  if (!answer) out(1, { ok: false, error: 'DeepSeek returned no answer', finish: ((j.choices || [])[0] || {}).finish_reason });
  out(0, { ok: true, answer });
})();
