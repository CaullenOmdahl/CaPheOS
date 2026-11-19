#!/usr/bin/env node
/* console/models.js — the owner console's per-seat model endpoints (Crew > seat > Model, and the Usage chains table).
 * Every write acts as the owner through company/tools/models.js, so the owner's change takes the same path (and the
 * same checks: allowed models only, applied to the seat's roster model and its routines) as one made in a shell.
 *
 *   GET  /api/models                          every seat: primary, chain (each entry: can run / why), running now and why
 *   GET  /api/models/seat/<id>                one seat, with its full move history
 *   GET  /api/models/providers                the allowed providers, connected or not on the station
 *   GET  /api/models/catalog/<provider>       the allowed models of one provider, with the station's efforts for each
 *   POST /api/models/seat/<id>/primary        { provider, model, effort? }   the seat's primary (the rest of the chain stays)
 *   POST /api/models/seat/<id>/chain          { chain: [{ provider, model, effort? }, ...] }   the whole ordered chain
 *   POST /api/models/seat/<id>/unblock        { why? }   clear the seat's refusal block (owner only; pacer.js unblock)
 *
 * Mounted by console/server.js: require('./models.js').mount(route, deps). All of /api is owner-only (the console token).
 *   node console/models.js --selftest         a temp company, a fake station and a console server: exercises every route
 */
'use strict';
const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const { spawn } = require('child_process');

const SEAT = '([A-Za-z0-9_.:-]{1,80})';
const PROVIDER = /^[a-z0-9][a-z0-9_-]{0,40}$/;

function mount(route, d) {
  const { co, runApi, stationGet, bad, owner } = d;
  const policy = () => { try { return JSON.parse(fs.readFileSync(co.p('company', 'model-policy.json'), 'utf8')); } catch (_) { return {}; } };
  const entryArg = e => {
    if (!e || typeof e !== 'object') bad('each chain entry is { provider, model, effort? }');
    const p = String(e.provider || '').trim(), m = String(e.model || '').trim(), ef = e.effort ? String(e.effort).trim() : '';
    if (!PROVIDER.test(p) || !m || m.length > 200 || /[,@\s]/.test(m) || (ef && !/^[a-z]{1,12}$/.test(ef))) bad('bad chain entry: ' + JSON.stringify(e).slice(0, 120));
    return p + '/' + m + (ef ? '@' + ef : '');
  };
  const withWhy = d => { for (const s of (d && d.seats) || []) if (s && s.now) s.now.plain = currentWhy(s); return d; };
  route('GET', /^\/api\/models$/, async () => withWhy(await runApi('models.js', ['show', '--json'], { timeout: 30000 })));
  route('GET', new RegExp('^/api/models/seat/' + SEAT + '$'), async m => withWhy(await runApi('models.js', ['show', '--seat', m[1], '--json'], { timeout: 30000 })));
  route('GET', /^\/api\/models\/providers$/, async () => {
    const pol = policy(), allowed = pol.allowed || {};
    const r = await stationGet('providers', 8000);
    const list = r.ok && r.data && Array.isArray(r.data.providers) ? r.data.providers : null;
    return { ok: true, station: list ? 'up' : 'down', providers: Object.keys(allowed).map(id => {
      const p = list && list.find(x => x && x.id === id);
      return { id, name: (p && (p.name || p.label)) || id, connected: p ? p.configured === true : null, reason: p ? p.reason || null : (list ? 'not on this station' : 'station not answering'), note: allowed[id].note || '' };
    }) };
  });
  route('GET', /^\/api\/models\/catalog\/([a-z0-9_-]{1,40})$/, async m => {
    const pol = policy(), fam = (pol.allowed || {})[m[1]];
    if (!fam) bad(m[1] + ' is not an allowed provider (company/model-policy.json allowed)', 404);
    const r = await stationGet('models/' + encodeURIComponent(m[1]), 8000);
    const cat = r.ok && r.data && Array.isArray(r.data.models) ? r.data.models : [];
    const tiers = fam.tiers || {};
    return { ok: true, provider: m[1], stationError: r.ok ? (r.data && r.data.error) || null : (r.error || 'station not answering'),
      models: (fam.models || []).map(id => { const c = cat.find(x => x && x.id === id); return { id, name: (c && c.name) || id, onStation: !!c, efforts: (c && c.reasoningEfforts) || [], tier: tiers[id] || null }; }) };
  });
  // the owner clears a seat's refusal block (pacer.js unblock: recorded, the seat's manager told, effective next tick)
  route('POST', new RegExp('^/api/models/seat/' + SEAT + '/unblock$'), (m, q, b) => {
    const why = b && b.why ? String(b.why).trim().slice(0, 300) : '';
    if (why.startsWith('--')) bad('why may not start with --');
    return runApi('pacer.js', ['unblock', m[1], '--by', owner()].concat(why ? ['--why', why] : []), { timeout: 30000 });
  });
  route('POST', new RegExp('^/api/models/seat/' + SEAT + '/primary$'), (m, q, b) => {
    const args = ['set', m[1], '--primary', entryArg({ provider: b.provider, model: b.model }), '--by', owner()];
    if (b.effort) { if (!/^[a-z]{1,12}$/.test(String(b.effort))) bad('bad effort'); args.push('--effort', String(b.effort)); }
    return runApi('models.js', args, { timeout: 60000 });
  });
  route('POST', new RegExp('^/api/models/seat/' + SEAT + '/chain$'), (m, q, b) => {
    if (!Array.isArray(b.chain) || !b.chain.length) bad('chain is a non-empty list of { provider, model, effort? }; the first is the primary');
    if (b.chain.length > 8) bad('at most 8 entries');
    return runApi('models.js', ['chain', m[1], '--set', b.chain.map(entryArg).join(','), '--by', owner()], { timeout: 60000 });
  });
}

/* currentWhy(seat) — Settings › Models' Why column: only when something is unusual, and from the chain's CURRENT
 * evaluation (each entry's ok/why as the tool measured it now), never the reason of the last move (that one goes stale:
 * "checking local sign-in" an hour after the provider recovered). null when the seat is where it should be. */
const PNAME = { 'claude-cli': 'Claude', custom: 'MiniMax', deepseek: 'DeepSeek', minimax: 'MiniMax' };
const pname = e => (e && (PNAME[e.provider] || e.provider)) || 'its model';
function currentWhy(s) {
  const base = chainWhy(s);
  // a refused run that fell over to the next model (lib/refusal.js) in the last 24 h is always worth a line
  const r = s && s.lastRefusal;
  return r ? (r.why + ' (' + String(r.at).slice(11, 16) + ' UTC)') + (base ? ' ' + base : '') : base;
}
function chainWhy(s) {
  const chain = (s && s.chain) || [], now = (s && s.now) || {}, idx = now.index;
  if (!s || !s.hasChain || !chain.length) return null;
  const p = chain[0];
  if (idx === 0) return p.ok ? null : p.settling ? pname(p) + ' is still starting on the station; it waits rather than moving.' : 'Its primary cannot run right now: ' + p.why + '.';
  if (idx > 0) {
    const better = chain.slice(0, idx).find(x => x.ok);
    if (better) return 'On a fallback for now. ' + pname(better) + ' can run again, so it moves back up shortly.';
    return 'On a fallback: ' + pname(p) + ' cannot run right now (' + String(p.why || 'unavailable').replace(/^the /, '') + ').';
  }
  return 'Not on a model in its chain; the next check moves it.';
}

/* ---------- selftest ---------- */
async function selftest() {
  const REPO = path.resolve(process.env.CAPHEOS_ROOT || path.join(__dirname, '..'));
  const tmp = require('../company/tools/lib/temp-life').tmpDir('console-models-selftest-');
  fs.cpSync(path.join(REPO, 'company'), path.join(tmp, 'company'), { recursive: true, filter: s => !/[\/\\]\.starnet-data([\/\\]|$)/.test(s) });
  fs.cpSync(path.join(REPO, 'console'), path.join(tmp, 'console'), { recursive: true });
  const w = (rel, d) => { const f = path.join(tmp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof d === 'string' ? d : JSON.stringify(d, null, 1)); };
  w('secrets/station-token', 'fake-token\n');
  w('company/company.json', Object.assign({}, JSON.parse(fs.readFileSync(path.join(REPO, 'company', 'company.json'), 'utf8')), { owner: { name: 'Pat Owner' } }));
  w('company/tools/loops.json', { agents: { agent: { name: 'Alex', functions: ['ceo', 'people', 'tools', 'risk', 'floor', 'finance'], manager: null, loop: 'Founder loop', inbox: 'to-alex.md' },
    eng: { name: 'Jo', manager: 'agent', loop: 'Jo loop', inbox: 'to-jo.md' } } });
  for (const f of ['model-moves.jsonl', 'models-state.json']) { try { fs.rmSync(path.join(tmp, 'company', 'state', f)); } catch (_) {} }
  { const pol = JSON.parse(fs.readFileSync(path.join(tmp, 'company', 'model-policy.json'), 'utf8')); delete pol.seats; w('company/model-policy.json', pol); }
  const S = { providers: { deepseek: true, 'claude-cli': true, custom: false }, roster: {}, jobs: [{ id: 'j1', name: 'Founder loop', agentId: 'agent', provider: 'deepseek', model: 'deepseek-flash' }, { id: 'j2', name: 'Jo loop', agentId: 'eng', provider: 'deepseek', model: 'deepseek-flash' }], calls: [] };
  const fake = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => { raw += c; }); req.on('end', () => {
      const J = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.headers['x-starnet-token'] !== 'fake-token') return J(401, { error: 'token' });
      const u = new URL(req.url, 'http://x'), b = raw ? JSON.parse(raw) : {};
      S.calls.push({ m: req.method, p: u.pathname, b });
      if (u.pathname === '/api/providers') return J(200, { providers: Object.entries(S.providers).map(([id, c]) => ({ id, name: id.toUpperCase(), configured: c, reason: c ? 'verified' : 'credential missing' })) });
      if (u.pathname === '/api/models/deepseek') return J(200, { provider: 'deepseek', models: [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', reasoningEfforts: ['none', 'low', 'high', 'max'] }, { id: 'deepseek-v4-pro' }] });
      if (u.pathname.startsWith('/api/models/')) return J(200, { models: [], error: 'configure it', code: 'provider_not_configured' });
      if (u.pathname === '/api/cron' && req.method === 'GET') return J(200, { jobs: S.jobs });
      if (u.pathname === '/api/cron/update') { const j = S.jobs.find(x => x.id === b.id); Object.assign(j, b.patch); return J(200, { ok: true, job: j }); }
      if (u.pathname === '/api/agent/model') { if (!S.providers[b.provider]) return J(409, { error: 'not connected' }); S.roster[b.agentId] = b; return J(200, { ok: true, via: 'roster' }); }
      if (u.pathname === '/api/budget/status') return J(200, { caps: { perDay: 25 }, day: { usd: 1 }, live: 0 });
      J(404, { error: 'fake: ' + u.pathname });
    });
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const env = Object.assign({}, process.env, { CAPHEOS_ROOT: tmp, STARNET_URL: 'http://127.0.0.1:' + fake.address().port });
  delete env.CONSOLE_PORT;
  const child = spawn(process.execPath, [path.join(tmp, 'console', 'server.js'), '--port', '0', '--print-port'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let errText = ''; child.stderr.on('data', x => { errText += x; });
  const cases = []; const check = (n, c, info) => { cases.push(!!c); console.log((c ? 'ok   ' : 'FAIL ') + n + (c || info === undefined ? '' : '  ' + JSON.stringify(info).slice(0, 500))); };
  try {
    const port = await new Promise((resolve, reject) => { let buf = ''; child.stdout.on('data', x => { buf += x; const m = buf.match(/\{"port":(\d+)\}/); if (m) resolve(Number(m[1])); }); child.on('exit', c => reject(new Error('server exited ' + c + ': ' + errText))); setTimeout(() => reject(new Error('server did not start: ' + errText)), 10000); });
    const token = fs.readFileSync(path.join(tmp, 'secrets', 'console-token'), 'utf8').trim();
    const call = (method, p, body, hdr) => new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: Object.assign(hdr || { 'x-console-token': token }, data ? { 'content-type': 'application/json' } : {}) }, res => {
        let x = ''; res.on('data', c => { x += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(x); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
      });
      req.setTimeout(60000, () => req.destroy(new Error('timeout ' + p))); req.on('error', reject); if (data) req.write(data); req.end();
    });
    let r = await call('GET', '/api/models', undefined, {});
    check('models endpoints are owner-only (no token: 401)', r.status === 401, r.status);
    r = await call('GET', '/api/models');
    check('GET /api/models lists every seat, none with a chain yet, and the station-wide backstop', r.status === 200 && r.json.seats.length === 2 && r.json.seats.every(s => !s.hasChain) && /fallback chain/.test(r.json.backstop), r.json);
    r = await call('GET', '/api/models/providers');
    check('GET /api/models/providers: the allowed providers with connected or not', r.json.ok && r.json.providers.find(p => p.id === 'deepseek').connected === true && r.json.providers.find(p => p.id === 'custom').connected === false, r.json);
    r = await call('GET', '/api/models/catalog/deepseek');
    check('GET /api/models/catalog/deepseek: allowed models only, with the station\'s efforts', r.json.ok && r.json.models.length === 1 && r.json.models[0].id === 'deepseek-flash' && r.json.models[0].efforts.includes('high'), r.json);
    r = await call('GET', '/api/models/catalog/openai');
    check('a provider off the allowed list: 404', r.status === 404, r.json);
    r = await call('POST', '/api/models/seat/eng/chain', { chain: [{ provider: 'claude-cli', model: 'claude-sonnet-5-5', effort: 'medium' }, { provider: 'deepseek', model: 'deepseek-flash' }, { provider: 'custom', model: 'MiniMax-M3.1-Flash' }] });
    check('POST chain as the owner: saved and the primary applied to the roster model and the routine', r.status === 200 && r.json.ok && r.json.owner && S.roster.eng && S.roster.eng.provider === 'claude-cli' && S.jobs[1].provider === 'claude-cli' && S.jobs[1].reasoningEffort === 'medium', { r: r.json, roster: S.roster, job: S.jobs[1] });
    const pol = JSON.parse(fs.readFileSync(path.join(tmp, 'company', 'model-policy.json'), 'utf8'));
    check('the chain is in model-policy.json seats.eng, set by the owner', pol.seats.eng.chain.length === 3 && pol.seats.eng.setBy === 'Pat Owner', pol.seats);
    r = await call('POST', '/api/models/seat/eng/chain', { chain: [{ provider: 'deepseek', model: 'deepseek-v4-pro' }] });
    check('a model off the allowed list is refused (400) and nothing changes', r.status === 400 && /allowed/.test(r.json.error) && JSON.parse(fs.readFileSync(path.join(tmp, 'company', 'model-policy.json'), 'utf8')).seats.eng.chain.length === 3, r.json);
    r = await call('POST', '/api/models/seat/eng/chain', { chain: [{ provider: 'deepseek', model: 'a,b' }] });
    check('a malformed entry is refused before any tool runs (400)', r.status === 400, r.json);
    r = await call('POST', '/api/models/seat/eng/primary', { provider: 'deepseek', model: 'deepseek-flash', effort: 'high' });
    check('POST primary: moves the new primary to the front, keeps the rest, applies it', r.json.ok && r.json.chain[0] === 'deepseek/deepseek-flash (high)' && r.json.chain.length === 3 && S.jobs[1].provider === 'deepseek', r.json);
    r = await call('GET', '/api/models/seat/eng');
    const jo = r.json && r.json.seats && r.json.seats[0];
    check('GET one seat: each entry says connected or not, running now on the primary, history of moves', jo && jo.chain.find(e => e.provider === 'custom').connected === false && jo.now.index === 0 && /primary/.test(jo.now.why) && jo.history.length === 2 && jo.history[0].direction === 'set', jo);
    check('currentWhy: nothing unusual on a primary that can run; a recovered primary is said from the current state, not the last move', currentWhy({ hasChain: true, chain: [{ provider: 'claude-cli', ok: true }], now: { index: 0 } }) === null
      && /Claude can run again/.test(currentWhy({ hasChain: true, chain: [{ provider: 'claude-cli', ok: true }, { provider: 'deepseek', ok: true }], now: { index: 1, why: 'fallback 1 of 1: checking local sign-in' } }))
      && !/checking local sign-in/.test(currentWhy({ hasChain: true, chain: [{ provider: 'claude-cli', ok: true }, { provider: 'deepseek', ok: true }], now: { index: 1 } }))
      && currentWhy({ hasChain: false, chain: [], now: { index: -1 } }) === null);
    check('currentWhy: a refused run that fell over to the next model is said (lib/refusal.js lastRefusal)', /Claude declined this; DeepSeek answered instead/.test(currentWhy({ hasChain: true, chain: [{ provider: 'claude-cli', ok: true }], now: { index: 0 }, lastRefusal: { at: '2030-01-01T10:00:00.000Z', why: 'Claude declined this; DeepSeek answered instead. (chat, one retry)' } }) || ''));
    r = await call('GET', '/api/models');
    check('GET /api/models carries now.plain (current-state Why)', r.json.seats.every(s => 'plain' in s.now), r.json.seats.map(s => s.now));
    r = await call('POST', '/api/models/seat/nobody/chain', { chain: [{ provider: 'deepseek', model: 'deepseek-flash' }] });
    check('an unknown seat: 400', r.status === 400, r.json);
  } catch (e) { check('selftest ran to the end', false, e.stack); }
  finally { child.kill(); fake.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} }
  const failed = cases.filter(c => !c).length;
  console.log(failed ? 'CONSOLE MODELS SELFTEST FAILED: ' + failed + ' of ' + cases.length : 'CONSOLE MODELS SELFTEST PASSED: ' + cases.length + ' checks');
  return failed ? 1 : 0;
}

module.exports = { mount, selftest, currentWhy };
if (require.main === module && process.argv.includes('--selftest')) selftest().then(c => process.exit(c), e => { console.error(e); process.exit(1); });
