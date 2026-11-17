#!/usr/bin/env node
/* Chat actions and approvals in chat (docs/CHAT-ACTIONS.md): headless Chrome against the dev mock (MOCK_ACTIONS=1).
 * md.js: a good block, a malformed one (plain text + note), the link allowlist, read-only where nothing can answer.
 * The chat walk: buttons, a choice, a URL field, a slider and a key field render from Today's components; a click sends
 * the reply as the owner's next message and locks the block; the key is stored and never shown; reload keeps it locked;
 * an old block and a superseded one are expired. Approvals: an existing record answers through the approval API; a
 * fixed gate links to Needs you; a hand-made block is inert; the Needs-you badge counts each record once; the company
 * approval and the station's tool permission look different; archiving the chat leaves the approval on Needs you.
 * The no-tool test: every request a click makes is one of: the chat send, the owner message, the key store, the
 * approval API. SKIP without Chrome. */
'use strict';
const { spawn, spawnSync } = require('child_process'); const path = require('path'); const os = require('os'); const fs = require('fs');
const bin = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find(b => spawnSync('which', [b]).status === 0);
if (!bin) { console.log('SKIP chat-actions-walk: no Chrome'); process.exit(0); }
const mockPort = 9100 + Math.floor(Math.random() * 300), cdpPort = 9500 + Math.floor(Math.random() * 300);
const mock = spawn(process.execPath, [path.join(__dirname, '..', 'console', 'ui', 'dev', 'mock-api.js'), String(mockPort)], { env: Object.assign({}, process.env, { MOCK_CERTIFIED: '1', MOCK_NO_PUSH: '1', MOCK_ACTIONS: '1' }), stdio: 'ignore' });
const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'chatact-'));
const chrome = spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run', '--user-data-dir=' + udd, '--remote-debugging-port=' + cdpPort, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
const done = code => { try { chrome.kill(); } catch (_) {} try { mock.kill(); } catch (_) {} try { fs.rmSync(udd, { recursive: true, force: true }); } catch (_) {} process.exit(code); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms) { const end = Date.now() + ms; for (;;) { try { const v = await fn(); if (v) return v; } catch (_) {} if (Date.now() > end) return null; await sleep(150); } }
const BASE = 'http://127.0.0.1:' + mockPort;
const SECRET = 'sk-walk-secret-value-' + 'x'.repeat(12);
// what a click may reach: the chat send, the owner channel, the key store, the approval API (and the reads that follow)
const ALLOWED_POST = [/^\/api\/chat\/agent\/send$/, /^\/api\/owner\/messages$/, /^\/api\/chat-actions\/secret$/, /^\/api\/approvals\/q-\d+\/answer$/];
(async () => {
  const ok = await waitFor(async () => (await fetch(BASE + '/')).ok, 15000); if (!ok) { console.log('FAIL mock did not start'); return done(1); }
  const tab = await waitFor(async () => (await (await fetch('http://127.0.0.1:' + cdpPort + '/json')).json()).find(t => t.type === 'page'), 15000);
  if (!tab) { console.log('FAIL chrome did not start'); return done(1); }
  const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const pend = {}; ws.onmessage = m => { const j = JSON.parse(m.data); if (j.id && pend[j.id]) { pend[j.id](j); delete pend[j.id]; } };
  const cmd = (method, params) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => ((await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result || {}).result?.value;
  let fails = 0; const t = (name, cond, info) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' — ' + JSON.stringify(info))); if (!cond) fails++; };
  // every request the page makes, with its method, from the first script on
  await cmd('Page.enable', {});
  await cmd('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__calls=[];const __f=window.fetch;window.fetch=function(u,o){try{window.__calls.push({u:String(u).replace(location.origin,"").split("?")[0],m:(o&&o.method)||"GET",b:o&&o.body?String(o.body):""})}catch(_){}return __f.apply(this,arguments)};' });
  const open = async hash => { await cmd('Page.navigate', { url: BASE + '/' + hash }); await sleep(300); };
  const calls = () => ev('window.__calls.slice()');
  const mark = () => ev('window.__calls.length');
  const since = async n => (await calls()).slice(n);
  const noTool = (list, label) => { const posts = list.filter(c => c.m !== 'GET'); const bad = posts.filter(c => !ALLOWED_POST.some(re => re.test(c.u))); t('no-tool: ' + label + ': every request is a message, the key store or the approval API', !bad.length && posts.length > 0, { posts, bad }); return posts; };

  /* ---------- md.js on its own ---------- */
  await open('#/today');
  await waitFor(() => ev('!!document.querySelector(".needs-link")'), 10000);
  const mdr = await ev(`import('/js/md.js').then(m => {
    const good = m.mdBlock('Pick:\\n\\n\`\`\`actions\\n{"id":"p","prompt":"Pick one","items":[{"type":"button","label":"A","value":"a"},{"type":"link","label":"Docs","href":"https://example.org"},{"type":"link","label":"Bad","href":"javascript:alert(1)"}]}\\n\`\`\`');
    const bad = m.mdBlock('\`\`\`actions\\n{"id":"p","items":[{"type":"exec","label":"x","command":"rm -rf /"}]}\\n\`\`\`');
    const notjson = m.mdBlock('\`\`\`actions\\n{nope\\n\`\`\`');
    const open = m.mdBlock('\`\`\`actions\\n{"id":"p","items":[');
    const sec = m.mdBlock('\`\`\`actions\\n{"id":"k","items":[{"type":"secret","id":"k","label":"Key","name":"../station-token"}]}\\n\`\`\`');
    const hooked = m.mdBlock('\`\`\`actions\\n{"id":"h","items":[{"type":"button","label":"B","value":"b","run":"x"}]}\\n\`\`\`', '', { actions: b => { window.__hook = b; return document.createElement('hr'); } });
    return { goodRO: !!good.querySelector('.chat-actions.readonly') && !good.querySelector('button'), goodLinks: [...good.querySelectorAll('a')].map(a => a.getAttribute('href') + '|' + (a.target || '')),
      badNote: bad.textContent.includes("Couldn't show these buttons") && !bad.querySelector('button, input') && !!bad.querySelector('pre'),
      notjson: notjson.textContent.includes("Couldn't show these buttons (not JSON)"), open: open.textContent.includes('Preparing buttons'),
      secBad: sec.textContent.includes("Couldn't show these buttons") && !sec.querySelector('input'),
      hook: !!hooked.querySelector('hr') && JSON.stringify(window.__hook.items) };
  })`);
  t('md.js: a good block renders read-only where nothing can answer it (no buttons)', mdr && mdr.goodRO, mdr);
  t('md.js: link allowlist: https opens a new tab, javascript: is dropped', mdr && mdr.goodLinks.join() === 'https://example.org|_blank', mdr && mdr.goodLinks);
  t('md.js: a malformed block (unknown type, a "command") is plain text with the note, no controls', mdr && mdr.badNote && mdr.notjson, mdr);
  t('md.js: a block still streaming shows a placeholder; a secret named outside secrets/ is refused', mdr && mdr.open && mdr.secBad, mdr);
  t('md.js: the hook gets only the known keys (an agent\'s "run" is dropped)', mdr && mdr.hook === '[{"type":"button","label":"B","value":"b"}]', mdr && mdr.hook);

  /* ---------- the chat ---------- */
  await open('#/chat/agent');
  const ready = await waitFor(() => ev('!!document.querySelector(\'.chat-actions[data-actions-id="launch"]\') && !!document.querySelector(".company-approval[data-state=pending]")'), 15000);
  t('the chat renders the agent\'s actions blocks', !!ready);
  const r0 = await ev(`(() => { const b = document.querySelector('.chat-actions[data-actions-id="launch"]'); const k = document.querySelector('.chat-actions[data-actions-id="feed-key"]');
    const tones = [...document.querySelectorAll('.chat-actions[data-actions-id="tone"]')].map(x => x.dataset.state || 'live');
    return { radios: b.querySelectorAll('.q-choice input[type=radio]').length, url: !!b.querySelector('input[type=url]'), range: !!b.querySelector('input[type=range]'),
      buttons: [...b.querySelectorAll('.chat-actions-row button')].map(x => x.textContent + ':' + x.className.includes('btn-primary')),
      links: [...b.querySelectorAll('a.chat-action-link')].map(a => a.getAttribute('href') + '|' + (a.target || '') + '|' + (a.rel || '')), evil: !![...b.querySelectorAll('a')].find(a => /javascript/i.test(a.href)),
      secret: !!k && k.querySelector('input[type=password]') !== null, old: (document.querySelector('.chat-actions[data-actions-id="old-pick"]') || {}).dataset?.state,
      oldText: (document.querySelector('.chat-actions[data-actions-id="old-pick"] .chat-actions-state') || {}).textContent, oldDisabled: [...document.querySelectorAll('.chat-actions[data-actions-id="old-pick"] button')].every(x => x.disabled),
      tones, bad: (document.querySelector('.chat-actions-bad') || {}).textContent || '' }; })()`);
  t('a choice, a URL field and a slider (Today\'s components), primary tone on the first button', r0 && r0.radios === 2 && r0.url && r0.range && r0.buttons.join() === 'Launch now:true,Wait a week:false', r0);
  t('link buttons: console route in-app, web link in a new tab with noopener; javascript: never a link', r0 && r0.links.join() === '#/spend||,https://example.org/docs|_blank|noopener noreferrer' && !r0.evil, r0 && r0.links);
  t('a key field is a password input', r0 && r0.secret, r0);
  t('a block older than 24 h renders expired and disabled', r0 && r0.old === 'expired' && /older than 24 hours/.test(r0.oldText) && r0.oldDisabled, r0);
  t('a block superseded by a newer one with the same id renders expired', r0 && r0.tones.join() === 'expired,live', r0 && r0.tones);
  t('a malformed block in the chat is its text with "Couldn\'t show these buttons"', r0 && /Couldn't show these buttons/.test(r0.bad), r0 && r0.bad);

  // click: a bad URL is not sent; then a real reply
  let n = await mark();
  await ev(`(() => { const b = document.querySelector('.chat-actions[data-actions-id="launch"]'); const u = b.querySelector('input[type=url]'); u.value = 'ftp://nope'; u.dispatchEvent(new Event('input')); [...b.querySelectorAll('button')].find(x => x.textContent === 'Launch now').click(); })()`);
  await sleep(300);
  t('an invalid URL keeps the block open and sends nothing', (await since(n)).filter(c => c.m !== 'GET').length === 0 && await ev(`!document.querySelector('.chat-actions[data-actions-id="launch"]').dataset.state`));
  n = await mark();
  await ev(`(() => { const b = document.querySelector('.chat-actions[data-actions-id="launch"]'); const u = b.querySelector('input[type=url]'); u.value = 'https://example.org/launch'; u.dispatchEvent(new Event('input'));
    const r = b.querySelector('input[type=range]'); r.value = '60'; r.dispatchEvent(new Event('input')); b.querySelector('.q-choice input[value=eu]').click();
    [...b.querySelectorAll('button')].find(x => x.textContent === 'Launch now').click(); })()`);
  const sent = await waitFor(() => ev(`(() => { const m = [...document.querySelectorAll('.msg-me.action-reply')].pop(); return m && m.dataset.replyId === 'launch' ? m.textContent : null; })()`), 8000);
  t('the reply appears as the owner\'s message, in words', sent === 'Chose: Launch now · Region Europe, Landing page https://example.org/launch, Budget share 60%', sent);
  t('the block locks and shows the choice', await ev(`(() => { const b = document.querySelector('.chat-actions[data-actions-id="launch"]'); return b.dataset.state === 'answered' && [...b.querySelectorAll('button,input')].every(x => x.disabled) && /^Answered: Chose: Launch now/.test(b.querySelector('.chat-actions-state').textContent); })()`));
  const p1 = noTool(await since(n), 'a reply button');
  const body1 = p1[0] ? JSON.parse(p1[0].b) : {};
  t('the reply carries the machine line; the agent\'s "run"/"tool" keys never travel', /\n\[actionReply \{"id":"launch","value":"now","fields":\{"region":"eu","site":"https:\/\/example.org\/launch","share":60\}\}\]$/.test(body1.text || '') && !/rm -rf|code\.run/.test(body1.text || ''), body1);
  await waitFor(() => ev('!document.querySelector(".msg-them-wrap.live")'), 8000);

  // the key: stored through the key store, the reply says only where and how long
  n = await mark();
  await ev(`(() => { const k = document.querySelector('.chat-actions[data-actions-id="feed-key"]'); const i = k.querySelector('input[type=password]'); i.value = ${JSON.stringify(SECRET)}; i.dispatchEvent(new Event('input')); [...k.querySelectorAll('button')].find(x => x.textContent === 'Store').click(); })()`);
  const stored = await waitFor(() => ev(`(() => { const m = [...document.querySelectorAll('.msg-me.action-reply')].pop(); return m && m.dataset.replyId === 'feed-key' ? m.textContent : null; })()`), 8000);
  t('the key reply says "Stored example-feed-key (N chars)"', stored === 'Stored example-feed-key (' + SECRET.length + ' chars)', stored);
  const p2 = noTool(await since(n), 'a key field');
  t('the key goes to the key store only, never into the chat message', p2.length === 2 && /chat-actions\/secret$/.test(p2[0].u) && p2[0].b.includes(SECRET) && !p2[1].b.includes(SECRET), p2.map(c => c.u));
  await waitFor(() => ev('!document.querySelector(".msg-them-wrap.live")'), 8000);
  const chatNow = await (await fetch(BASE + '/api/chat/agent')).json();
  t('secret never echoed: not in the transcript, the page, or the mock\'s record', !JSON.stringify(chatNow).includes(SECRET) && !(await ev('document.body.innerText')).includes(SECRET) && !JSON.stringify(await (await fetch(BASE + '/api/__mock/actions')).json()).includes(SECRET));

  // reload: answered blocks stay locked with their value, expired stay expired
  await open('#/chat/agent');
  await waitFor(() => ev('!!document.querySelector(\'.chat-actions[data-actions-id="launch"]\')'), 10000);
  const r1 = await ev(`(() => { const s = id => { const b = document.querySelector('.chat-actions[data-actions-id="' + id + '"]'); return b ? (b.dataset.state || 'live') + '|' + b.querySelector('.chat-actions-state').textContent : null; }; return { launch: s('launch'), key: s('feed-key'), old: s('old-pick') }; })()`);
  t('reload: the answered block renders locked with the chosen value', r1 && /^answered\|Answered: Chose: Launch now · Region Europe/.test(r1.launch), r1);
  t('reload: the key block is locked as stored; the old one still expired', r1 && /^answered\|Answered: Stored example-feed-key/.test(r1.key) && /^expired/.test(r1.old), r1);

  /* ---------- approvals ---------- */
  const badge = () => ev('document.querySelector(".needs-link .n").textContent');
  const expected = () => ev(`Promise.all([fetch('/api/questions').then(r => r.json()), import('/js/ui.js')]).then(([d, u]) => String(d.questions.filter(q => !u.isSetupQuestion(q)).length))`);
  await waitFor(async () => (await badge()) !== '', 8000);
  const b0 = await badge(), e0 = await expected();
  const a0 = await ev(`(() => { const c = r => document.querySelector('.company-approval[data-ref="' + r + '"]'); const x = c('q-000201'), f = c('q-000202'), i = c('q-000999');
    return { prov: x && x.querySelector('.approval-prov').textContent, exp: x && x.querySelector('.approval-expiry').textContent, btns: x && [...x.querySelectorAll('button')].map(b => b.textContent),
      fixedBtns: f && f.querySelectorAll('button').length, fixedLink: f && (f.querySelector('a[href="#/today"]') || {}).textContent, fixedWhy: f && f.textContent,
      inert: i && i.dataset.state, inertCtl: i && i.querySelectorAll('button, input, a').length, inertText: i && i.textContent }; })()`);
  t('trap 1: the Needs-you badge counts each framework question once (approvals included, chat blocks not added)', b0 === e0 && Number(b0) > 0, { b0, e0 });
  t('approval: "Company approval · recorded in decisions", the expiry and its default from first render', a0 && a0.prov === 'Company approval · recorded in decisions' && /^expires .* · default: deny$/.test(a0.exp) && a0.btns.join() === 'Approve,Deny', a0);
  t('trap 4: a fixed owner gate has no inline approve: it links to Needs you and says why', a0 && a0.fixedBtns === 0 && /Open Needs you/.test(a0.fixedLink) && /fixed owner gate/.test(a0.fixedWhy), a0);
  t('trap 2: a hand-made block naming no record is inert text', a0 && a0.inert === 'inert' && a0.inertCtl === 0 && /no approval q-000999 on file/.test(a0.inertText), a0);
  n = await mark();
  await ev(`[...document.querySelector('.company-approval[data-ref="q-000201"]').querySelectorAll('button')].find(b => b.textContent === 'Approve').click()`);
  const appr = await waitFor(() => ev(`(() => { const x = document.querySelector('.company-approval[data-ref="q-000201"]'); return x && x.dataset.state === 'approved' ? x.querySelector('.approval-done').textContent : null; })()`), 8000);
  t('approve answers the existing record through the approval API and the card shows it', /^Approved · via chat/.test(appr || ''), appr);
  const p3 = noTool(await since(n), 'approve (trap 9, extended)');
  const mk = await (await fetch(BASE + '/api/__mock/actions')).json();
  const ans = mk.answers.find(a => a.id === 'q-000201');
  t('the answer carries surface chat and the shown digest', ans && ans.surface === 'chat' && /^sha256:/.test(ans.shownDigest) && p3.length === 1, { ans, p3 });
  await waitFor(async () => (await badge()) === String(Number(b0) - 1), 8000);
  t('trap 1: answering in chat takes it off the badge once (no double count)', (await badge()) === String(Number(b0) - 1) && (await badge()) === await expected(), { b: await badge(), b0 });

  // R-A: the station's tool permission prompt, in the same chat, looks different
  await ev(`(() => { const t = document.getElementById('msg'); t.value = 'please use a tool'; t.form.requestSubmit(); })()`);
  const both = await waitFor(() => ev(`(() => { const p = document.querySelector('.tool-permission'); const a = document.querySelector('.company-approval'); return p && a ? { p: p.querySelector('.consent-prov').textContent, a: a.querySelector('.approval-prov').textContent, pCls: p.className, aCls: a.className, pIsApproval: !!p.closest('.company-approval'), aBg: getComputedStyle(a).borderLeftWidth } : null; })()`), 8000);
  t('R-A: "Tool permission · station" and "Company approval · recorded in decisions" are distinct in one chat', both && both.p === 'Tool permission · station' && both.a === 'Company approval · recorded in decisions' && !both.pIsApproval && both.aBg === '4px', both);
  await ev(`(() => { const s = [...document.querySelectorAll('button')].find(b => b.textContent === 'Stop'); if (s) s.click(); })()`);
  await waitFor(() => ev('!document.querySelector(".msg-them-wrap.live")'), 8000);

  // the owner channel shares md.js: its blocks answer as the owner's next owner-channel message
  await open('#/chat/owner');
  await waitFor(() => ev('!!document.querySelector(\'.chat-actions[data-actions-id="away"] button\')'), 10000);
  n = await mark();
  await ev(`[...document.querySelectorAll('.chat-actions[data-actions-id="away"] button')].find(b => b.textContent === 'Keep it').click()`);
  const oc = await waitFor(() => ev(`(() => { const b = document.querySelector('.chat-actions[data-actions-id="away"]'); const me = [...document.querySelectorAll('.owner-msg .msg-me')].map(x => x.textContent); return b && b.dataset.state === 'answered' && me.includes('Chose: Keep it') ? me : null; })()`), 8000);
  t('owner channel: a button replies as an owner message ("Chose: Keep it", machine line hidden) and the block locks', !!oc, oc);
  const p4 = noTool(await since(n), 'an owner-channel button');
  t('owner channel: the reply is POST /api/owner/messages with the actionReply line', p4.length === 1 && /owner\/messages$/.test(p4[0].u) && /\n\[actionReply \{"id":"away","value":"keep"\}\]$/.test(JSON.parse(p4[0].b).text), p4);

  // trap 7: archiving the chat leaves the approval on Needs you
  await fetch(BASE + '/api/__mock/archive-chat', { method: 'POST' });
  await open('#/today');
  const still = await waitFor(() => ev('!!document.querySelector(\'.gate[data-id="q-000202"]\')'), 10000);
  t('trap 7: with the chat archived, the approval is still pending on Today › Needs you', !!still && (await (await fetch(BASE + '/api/approvals/q-000202')).json()).status === 'pending');

  ws.close(); console.log(fails ? 'CHAT ACTIONS WALK: FAIL' : 'CHAT ACTIONS WALK: PASS'); done(fails ? 1 : 0);
})().catch(e => { console.log('FAIL ' + e.message); done(1); });
