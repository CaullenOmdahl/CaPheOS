#!/usr/bin/env node
/* console-routes-walk.js — headless Chrome against the console mock (console/ui/dev/mock-api.js): the route map after the
 * console restructure ("Good UI doesn't need docs").
 *
 *   node tests/console-routes-walk.js [--shots <dir>]
 *
 * Checks:
 *  - every old route (#/comms, #/controls/…, #/governance, #/automate, #/usage, #/abilities/…, #/system, #/hiring,
 *    #/floor, #/setup/…, #/map) redirects to its new home, without a history entry, and that home renders;
 *  - the sidebar is Today · Chat · Crew · Work · Spend, then Settings pinned last; no Feature map; Setup only until certified;
 *  - every owner-facing screen, at desktop (1280 px) and phone (390 px) width, renders without a page exception, keeps the
 *    halt buttons on screen, and shows no `company/`, `.js` or `/api/` text outside a Details disclosure (agent-written
 *    markdown, `.md`, and a crew-made panel's body, `.panel-body`, are the crew's own words and are not checked), nor raw
 *    ids and tags (question ids, candidate ids, pacing tags, lane counters); Today is walked with the question fixtures;
 *  - Today's Now steps and Recent activity carry no shell command or tool-call markup, even inside their markdown;
 *  - Spend folds interview candidates into one row; Work and Crew show display names; Crew shows lanes only while running;
 *  - Crew shows its Floor tab only when the station reports a floor plan (a second, headless mock hides it);
 *  - while the company is not certified, #/setup stays the first-run wizard and the landing page is Setup.
 * Starts the mocks on free ports (never 8800). Exits 0 with "SKIP" when no Chrome is installed or Node has no WebSocket;
 * 1 on any failed check.
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http'); const net = require('net');
const argv = process.argv.slice(2);
const SHOTS = (i => i >= 0 ? argv[i + 1] : null)(argv.indexOf('--shots'));
const bin = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find(b => spawnSync('which', [b]).status === 0);
if (!bin) { console.log('SKIP console routes walk: no Chrome/Chromium installed'); process.exit(0); }
if (typeof WebSocket === 'undefined') { console.log('SKIP console routes walk: this Node has no WebSocket'); process.exit(0); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = async () => { for (;;) { const p = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const x = s.address().port; s.close(() => r(x)); }); }); if (p !== 8800 && p !== 8910) return p; } };
const getJson = u => new Promise((res, rej) => http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || info === undefined ? '' : ' — ' + JSON.stringify(info).slice(0, 700))); };
async function until(fn, ms) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(150); } return v; }

// old route -> where it must land (certified company)
const REDIRECTS = [
  ['#/comms', '#/chat'], ['#/comms/owner', '#/chat/owner'], ['#/comms/agent:agent', '#/chat/agent:agent'], ['#/comms/agent?draft=hi', '#/chat/agent?draft=hi'],
  ['#/controls', '#/settings/autonomy'], ['#/controls/gov', '#/settings/autonomy/presets'], ['#/controls/guardrails', '#/settings/autonomy/guardrails'],
  ['#/controls/ticks', '#/settings/tempo/ticks'], ['#/controls/cadence', '#/settings/tempo/ticks'], ['#/controls/sprint', '#/settings/tempo/sprint'], ['#/controls/panels', '#/settings/pages'],
  ['#/governance', '#/settings/autonomy/gate'], ['#/automate', '#/settings/tempo/routines'],
  ['#/usage', '#/spend'], ['#/usage/cutoffs', '#/settings/models/cutoffs'],
  ['#/abilities', '#/settings/connections'], ['#/abilities/api-keys', '#/settings/connections/keys'], ['#/abilities/skills', '#/settings/connections/skills'],
  ['#/system', '#/settings/system'], ['#/hiring', '#/crew/hiring'], ['#/floor', '#/crew/floor'], ['#/map', '#/settings/system/map'], ['#/map/company', '#/settings/system/map'],
  ['#/setup', '#/settings/company'], ['#/setup/charter', '#/settings/company/charter'], ['#/setup/provider', '#/settings/models/providers'], ['#/setup/ai', '#/settings/models/providers'],
  ['#/setup/budget', '#/settings/models/budget'], ['#/setup/guard', '#/settings/autonomy/guardrails'], ['#/setup/certify', '#/settings/company/certify'],
];
// every owner-facing screen (the halt screen included)
const SCREENS = ['#/today', '#/chat/owner', '#/chat/agent:agent', '#/chat/group:g1', '#/crew', '#/crew/agent/model', '#/crew/hiring', '#/crew/floor', '#/work/quests', '#/work/handoffs', '#/work/decisions', '#/work/projects',
  '#/spend', '#/settings/company', '#/settings/autonomy', '#/settings/tempo', '#/settings/models', '#/settings/connections', '#/settings/pages', '#/settings/system', '#/halt'];
// file paths, tool names, API routes, and the raw ids, tags and counters the owner should never read outside Details:
// question ids, candidate seat ids, governance/pacing tags, tool-call markup, lane counters, the pacer's jargon
const LEAK = /company\/|\.js\b|\/api\/|\bq-\d{4,}\b|\bcand-[a-z]|\b(governance|pacing):|<parameter|<invoke|parameter name=|lanes? running|days' share|% did nothing|\/item\b|proposals\/h|spend rail|\(owner-only|mode 0600/;
// agent-written text the console summarises (Now steps, Recent activity) is checked too, inside its markdown
const MARKUP = /<parameter|<invoke|parameter name=|`[^`]*(cd |grep|&&)|\bcd \/|&&|\/home\//;
// the visible text of the page outside any <details> body, outside agent-written markdown, scripts and styles
const VISIBLE = `(() => { const out = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) { const el = n.parentElement; if (!el || el.closest('script,style,noscript,dialog:not([open])')) continue;
    const d = el.closest('details'); if (d && !el.closest('summary')) continue; if (el.closest('.md, .panel-body')) continue;
    if (!el.getClientRects().length) continue; const t = n.textContent.trim(); if (t) out.push(t); }
  return out.join('\\n'); })()`;

async function startMock(env) {
  const port = await freePort();
  const mock = spawn(process.execPath, [path.join(__dirname, '..', 'console', 'ui', 'dev', 'mock-api.js'), String(port)], { env: Object.assign({}, process.env, { MOCK_NO_PUSH: '1' }, env), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; mock.stdout.on('data', d => { out += d; }); mock.stderr.on('data', d => { out += d; });
  if (!await until(async () => /mock console on/.test(out), 15000)) { mock.kill(); throw new Error('the mock did not start: ' + out.slice(-400)); }
  return { port, kill: () => mock.kill() };
}

(async () => {
  const mocks = [];
  const cport = await freePort();
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-walk-'));
  const chrome = spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + udd, '--remote-debugging-port=' + cport, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  const done = code => { try { chrome.kill(); } catch (_) {} mocks.forEach(m => { try { m.kill(); } catch (_) {} }); try { fs.rmSync(udd, { recursive: true, force: true }); } catch (_) {} setTimeout(() => process.exit(code), 200); };
  try {
    const certified = await startMock({ MOCK_CERTIFIED: '1' }); mocks.push(certified);
    const fresh = await startMock({ MOCK_HEADLESS: '1' }); mocks.push(fresh);
    const page = await until(async () => { try { return (await getJson('http://127.0.0.1:' + cport + '/json')).find(t => t.type === 'page' && t.webSocketDebuggerUrl); } catch (_) { return null; } }, 20000);
    if (!page) throw new Error('Chrome showed no page target in 20 s');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => { ws.onopen = r; });
    let id = 0; const pending = new Map(); const errors = [];
    ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      else if (m.method === 'Runtime.exceptionThrown') errors.push(String((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text).split('\n')[0]); };
    const send = (method, params) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
    const js = async e => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : undefined; };
    const shot = async name => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(s.result.data, 'base64')); };
    const width = (w, hgt) => send('Emulation.setDeviceMetricsOverride', { width: w, height: hgt, deviceScaleFactor: 1, mobile: w < 600 });
    const settled = () => until(() => js(`(() => { const t = (document.getElementById('main') || {}).innerText || ''; return t.trim().length > 40 && !/Loading…\\s*$/.test(t.trim()) && !/This screen did not load/.test(t); })()`), 8000);
    const go = async hash => { await js('location.hash = ' + JSON.stringify(hash.slice(1)) + '; 1'); await sleep(250); return settled(); };
    await send('Runtime.enable'); await send('Page.enable');

    /* ---- a certified company ---- */
    await send('Page.navigate', { url: 'http://127.0.0.1:' + certified.port + '/#/today' });
    await until(() => js(`!!document.querySelector('.nav-item')`), 10000);
    const nav = await until(() => js(`(() => { const v = [...document.querySelectorAll('nav.side .nav-item')].filter(a => !a.hidden && a.getClientRects().length).map(a => a.firstChild.textContent); return v.includes('Positions') ? v : null; })()`), 6000);
    check('the sidebar is Today, Chat, Crew, Work, Spend, then the Company pages, then Settings last (no Setup once certified, no Feature map)', JSON.stringify(nav) === JSON.stringify(['Today', 'Chat', 'Crew', 'Work', 'Spend', 'Positions', 'Settings']), nav);
    check('Settings sits below the Company group, pinned above the station box', await js(`(() => { const s = document.querySelector('.nav-bottom'); return !!s && s.nextElementSibling && s.nextElementSibling.classList.contains('station-box'); })()`));
    for (const [from, to] of REDIRECTS) {
      errors.length = 0;
      const before = await js('history.length');
      await js('location.hash = ' + JSON.stringify(from.slice(1)) + '; 1');
      const landed = await until(() => js(`location.hash === ${JSON.stringify(to)} ? location.hash : null`), 4000);
      const ok = landed && await settled();
      check('old route ' + from + ' redirects to ' + to, !!ok && !errors.length, { at: await js('location.hash'), errors });
      void before;
    }
    // a console: link an agent wrote with an old route points at the new home
    const mdHref = await js(`import('/js/md.js').then(m => { const el = m.mdBlock('[x](console:#/controls/guard) [y](console:#/usage)'); return [...el.querySelectorAll('a')].map(a => a.getAttribute('href')); })`);
    check('agent markdown links to old routes are rewritten to the new homes', JSON.stringify(mdHref) === JSON.stringify(['#/settings/autonomy/guardrails', '#/spend']), mdHref);
    for (const [w, hgt, label] of [[1280, 900, 'desktop'], [390, 844, 'phone']]) {
      await width(w, hgt);
      for (const s of SCREENS) {
        errors.length = 0;
        const ok = await go(s);
        await sleep(600);   // sections load their data after the first paint
        const text = await js(VISIBLE);
        const leaks = String(text || '').split('\n').filter(l => LEAK.test(l));
        const halt = await js(`(() => { const a = document.querySelector('.halt-btns a.halt-hard'); return !!a && a.getClientRects().length > 0; })()`);
        const wide = await js(`document.documentElement.scrollWidth <= window.innerWidth + 1`);
        check(label + ' ' + s + ' renders, keeps the halt buttons, no file paths, tool names or API routes outside Details' + (w < 600 ? ', no sideways scroll' : ''), !!ok && !errors.length && halt && !leaks.length && (w >= 600 || wide), { errors, leaks: leaks.slice(0, 6), halt, wide });
        if (s === '#/today') {
          const sum = await js(`(() => { const out = []; for (const el of document.querySelectorAll('.now-run .now-step, .timeline > li')) { const c = el.cloneNode(true); c.querySelectorAll('details').forEach(d => d.remove()); out.push(c.innerText); } return out; })()`);
          const bad = (sum || []).filter(t => MARKUP.test(t));
          check(label + ' Today: Now steps and Recent activity carry no shell command or tool-call markup (outside Details)', sum && sum.length >= 4 && !bad.length, { bad: bad.slice(0, 4), n: sum && sum.length });
        }
        if (SHOTS) await shot(label + '-' + s.replace(/[#/:?=]+/g, '-').replace(/^-|-$/g, ''));
      }
    }
    await width(1280, 900);
    // Settings: one screen, every section listed, the current one marked; tabs on a phone
    await go('#/settings/autonomy');
    const secs = await js(`[...document.querySelectorAll('.settings-nav a')].map(a => a.textContent + (a.getAttribute('aria-current') === 'page' ? '*' : ''))`);
    check('Settings lists its seven sections and marks the open one', JSON.stringify(secs) === JSON.stringify(['Company and charter', 'Autonomy and guardrails*', 'Tempo and routines', 'Models and subscriptions', 'Connections and keys', 'Console pages', 'System']), secs);
    // each guardrail shows its value, what it does and what switching it changes
    const g = await js(`(() => { const r = document.querySelector('#set-guard-spendCap'); return r ? { text: r.innerText, sw: !!r.querySelector('[role=switch]') } : null; })()`);
    check('a guardrail shows its current value, what it does and what flipping it changes', g && g.sw && /On/.test(g.text) && /stops at the daily cap/.test(g.text) && /If you switch it off/.test(g.text), g);
    // risky options ask first and say what they unlock
    await js(`document.querySelector('#set-guard-harnessSelfEdit [role=switch]').click(); 1`);
    const dlg = await until(() => js(`(() => { const d = document.querySelector('dialog.modal'); return d ? d.innerText : null; })()`), 3000);
    check('switching off harness review asks first and says what it unlocks', /Switch off Harness review\?/.test(dlg || '') && /This unlocks/.test(dlg || ''), dlg);
    await js(`[...document.querySelectorAll('dialog.modal button')].find(b => b.textContent === 'Cancel').click(); 1`);
    await js(`[...document.querySelectorAll('[role=radio]')].find(b => /Autonomous/.test(b.textContent)).click(); 1`);
    const dlg2 = await until(() => js(`(() => { const d = document.querySelector('dialog.modal'); return d ? d.innerText : null; })()`), 3000);
    check('picking Autonomous asks first and says what it unlocks', /Switch to Autonomous\?/.test(dlg2 || '') && /without asking you/.test(dlg2 || ''), dlg2);
    await js(`[...document.querySelectorAll('dialog.modal button')].find(b => b.textContent === 'Cancel').click(); 1`);
    await js(`[...document.querySelectorAll('button')].find(b => /Run with no guardrails/.test(b.textContent)).click(); 1`);
    const dlg3 = await until(() => js(`(() => { const d = document.querySelector('dialog.modal'); return d ? { t: d.innerText, typed: !!d.querySelector('input'), okDisabled: [...d.querySelectorAll('button')].find(b => /Switch everything off/.test(b.textContent)).disabled } : null; })()`), 3000);
    check('no guardrails asks for a typed sentence and says what it unlocks', dlg3 && dlg3.typed && dlg3.okDisabled && /This unlocks everything/.test(dlg3.t), dlg3);
    await js(`[...document.querySelectorAll('dialog.modal button')].find(b => b.textContent === 'Cancel').click(); 1`);
    // the station does not support GET /api/autonomy on the mock: the section is hidden, never "no such API route"
    check('an unsupported section is hidden, not a raw error', !(await js(`document.body.innerText.includes('no such API route')`)) && !(await js(`!!document.getElementById('set-posture')`)));
    // Crew › Floor exists on a station with a floor plan
    await go('#/crew');
    check('Crew has People, Hiring and Floor tabs when the station reports a floor', JSON.stringify(await until(() => js(`(() => { const t = [...document.querySelectorAll('[role=tablist][aria-label=Crew] [role=tab]')].map(b => b.firstChild.textContent); return t.includes('Floor') ? t : null; })()`), 5000)) === JSON.stringify(['People', 'Hiring', 'Floor']));
    await go('#/crew/floor');
    check('Crew › Floor shows the rooms and who sits where', await until(() => js(`(() => { const t = (document.querySelector('.floor-plan') || {}).innerText || ''; return /HOME/.test(t) && /WORKSHOP/.test(t) && /Founder/.test(t) && /Free desk/.test(t); })()`), 5000));
    // Spend is read-only: no inputs, and it links to Settings for the limits
    await go('#/spend');
    check('Spend shows today against the cap, by seat and by provider, and the week\'s subscription use, read-only', await until(() => js(`(() => { const m = document.getElementById('main'); const t = m.innerText; return /of \\$5/.test(t) && /By seat/.test(t) && /By provider/.test(t) && /Subscriptions this week/.test(t) && !m.querySelector('input, select, textarea') && !!m.querySelector('a[href="#/settings/models"]'); })()`), 5000));
    // Spend › By seat: interview candidates in one row that opens to their names; the crew by display name
    const seatsTxt = await js(`(() => { const r = [...document.querySelectorAll('#set-seats tr')].map(t => t.innerText.replace(/\\s+/g, ' ')); const g = document.querySelector('#set-seats [data-candidates]'); return { r, n: g && g.dataset.candidates, names: g && [...g.querySelectorAll('li')].map(l => l.firstChild.textContent) }; })()`);
    check('Spend › By seat: "Interview candidates (12)" as one row that lists their names; "Nadia Farrell" on her own row; no raw ids', seatsTxt && seatsTxt.n === '12' && seatsTxt.r.some(x => /^Interview candidates \(12\) \$0\.2\d/.test(x)) && seatsTxt.names.includes('Tobias Lin') && seatsTxt.r.some(x => /^Nadia Farrell \$/.test(x)) && !seatsTxt.r.some(x => /cand-/.test(x)), seatsTxt);
    // Work › Quests: the owner's display name, the quest id only under Details
    await go('#/work/quests');
    const qw = await until(() => js(`(() => { const t = (document.getElementById('main') || {}).innerText || ''; return /Backtest the quote recorder/.test(t) ? t : null; })()`), 5000);
    check('Work › Quests: owners by display name ("Nadia Farrell"), no "q:8" or raw agent ids in view', qw && /Nadia Farrell/.test(qw) && !/\bq:\d/.test(qw) && !/cand-|tools1/.test(qw), qw && qw.slice(0, 400));
    // Crew: the status words Today uses; lanes only while a seat runs more than one thing, never for the CEO
    await go('#/crew');
    const cw = await until(() => js(`(() => { const r = [...document.querySelectorAll('.crew-item')].map(b => ({ id: b.dataset.seat, t: b.innerText.replace(/\\s+/g, ' ') })); return r.some(x => /Resting/.test(x.t)) ? r : null; })()`), 5000);
    const seat = id => ((cw || []).find(x => x.id === id) || {}).t || '';
    check('Crew: "Nadia Farrell" Resting with the dispatcher\'s reason (not Idle beside "working"); Teo "Working on 2 things at once"; the Founder shows no lanes', cw && /Nadia Farrell/.test(seat('cand-tools-backtest-engineer-1-n')) && /Resting/.test(seat('cand-tools-backtest-engineer-1-n')) && !/Idle/.test(seat('cand-tools-backtest-engineer-1-n')) && /Working on 2 things at once/.test(seat('tools1')) && !/lane|things at once/i.test(seat('agent')) && !(cw || []).some(x => /Sprint:|lanes? running/.test(x.t)), cw);

    /* ---- a company still in its first run, on a headless station ---- */
    await send('Page.navigate', { url: 'http://127.0.0.1:' + fresh.port + '/' });
    const land = await until(() => js(`location.hash === '' && !!document.querySelector('#step-company') ? 'setup' : null`), 10000);
    check('before certification the landing page is the Setup wizard', land === 'setup', await js('location.hash'));
    check('the Setup wizard is in the nav before certification', await js(`(() => { const a = [...document.querySelectorAll('.nav-item')].find(x => x.firstChild.textContent === 'Setup'); return !!a && !a.hidden; })()`));
    await go('#/setup/charter');
    check('#/setup/charter stays the wizard (not redirected) before certification', await js(`location.hash`) === '#/setup/charter' && await until(() => js(`!!document.getElementById('step-charter') && document.getElementById('step-charter').open`), 4000));
    await go('#/crew');
    await sleep(800);
    check('a headless station has no Floor tab (hidden, not "Not connected yet")', JSON.stringify(await js(`[...document.querySelectorAll('[role=tablist][aria-label=Crew] [role=tab]')].map(b => b.firstChild.textContent)`)) === JSON.stringify(['People', 'Hiring']) && !(await js(`document.body.innerText.includes('Not connected yet')`)));
    errors.length = 0;
    await go('#/setup');
    await sleep(600);
    const st = await js(VISIBLE);
    const sl = String(st || '').split('\n').filter(l => LEAK.test(l));
    check('the Setup wizard shows no file paths, tool names or API routes outside Details', !sl.length && !errors.length, { leaks: sl.slice(0, 6), errors });

    console.log(fails ? 'CONSOLE ROUTES WALK: FAIL (' + fails + ')' : 'CONSOLE ROUTES WALK: PASS');
    ws.close(); done(fails ? 1 : 0);
  } catch (e) { console.error('console routes walk crashed: ' + e.stack); done(1); }
})();
