#!/usr/bin/env node
/* providers.js — the recorded way an agent applies a provider setting the OWNER approved. Today: the MiniMax endpoint.
 *
 *   node company/tools/providers.js set-endpoint minimax --region global|cn|custom [--base-url https://…/v1] [--other]
 *        --by <Name> --approval <q-id> [--dry-run]
 *   node company/tools/providers.js show                  the stored MiniMax endpoint (company.json providers.minimax)
 *   node company/tools/providers.js selftest            (or --selftest)
 *
 * Why it exists: a station provider setting lives in the station's key store (.starnet-data/workspaces/.secrets/), which
 * locked-watch.js holds as class K: any change nobody recorded is flagged to the risk owner. The owner changes it in
 * Settings (console/setup.js). An agent that got the owner's yes had no recorded route, so it edited the store by hand.
 * This tool is that route, and nothing more:
 *   - it refuses without --approval naming an owner question that was answered YES, whose text names MiniMax and the
 *     host being set (an approval for one address is not an approval for another), and that this tool has not already
 *     applied to the current setting;
 *   - --by must be the CEO or the people seat (model access), and the command must really run in that seat's run
 *     (provenance.callerConflict); "owner" only from the owner's own shell;
 *   - it refuses while the station's key store has a change the watcher has not accepted (the baseline differs): a hand
 *     edit is accepted or put right by the owner first, never blessed by a later tool run;
 *   - it applies through the station API the console uses (POST /api/providers/validate, then providers/connect, or
 *     providers/engine-key on a headless station), with the key the company already holds; it never edits the store;
 *   - after the station wrote, it records the files the station changed in the key store (provenance, writer
 *     providers.js) so locked-watch accepts exactly those bytes, writes company.json providers.minimax (the one source
 *     the console, pacer and inventory read), and adds a decision with decision.js.
 * Exit: 0 ok, 1 selftest failure or station error, 2 usage or refused. Owner of this tool: the tools function.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const WRITER = 'providers.js';
const sha = b => 'sha256:' + crypto.createHash('sha256').update(b).digest('hex');
const refuse = (msg, code) => Object.assign(new Error(msg), { code: code || 'refused' });
const SECRETS_REL = '.starnet-data/workspaces/.secrets';

function readLines(f) { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); } catch (_) { return []; } }
function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } }
function writeAtomic(f, text) { const t = f + '.tmp-' + process.pid; fs.writeFileSync(t, text); fs.renameSync(t, f); }

/* the owner's approval: an ask row and a structured YES answer; the question text names MiniMax and the host */
function approvalFor(rows, id, host) {
  const ask = rows.filter(r => r.type === 'ask' && r.id === id).pop();
  if (!ask) return { error: 'no owner question ' + id + ' in the inbox' };
  const ans = rows.filter(r => r.type === 'answer' && r.id === id).pop();
  if (!ans) return { error: id + ' has no answer yet' };
  if (!(ans.answer && ans.answer.verdict === 'yes')) return { error: id + ' was not answered yes (Approve)' };
  const text = [ask.q, ask.message, ask.details, ask.about].filter(Boolean).join(' ').toLowerCase();
  if (!/minimax/.test(text)) return { error: id + ' is not a question about MiniMax' };
  if (!text.includes(String(host).toLowerCase())) return { error: id + ' does not name ' + host + ': an approval covers the address it asked about' };
  return { ok: true, at: ans.at };
}

/* the key-store files that differ from the watcher's baseline (names only) */
function unreviewed(root, baseline) {
  const dir = path.join(root, SECRETS_REL); const out = [];
  let names = []; try { names = fs.readdirSync(dir); } catch (_) { return out; }
  const files = (baseline && baseline.files) || {};
  let status = []; try { status = require('./locked-watch.js').STATION_STATUS; } catch (_) {}
  for (const n of names) {
    if (status.includes(n)) continue;   // station-written readiness, rewritten on every probe: status, not key material
    const rel = SECRETS_REL + '/' + n; let buf; try { buf = fs.readFileSync(path.join(dir, n)); } catch (_) { continue; }
    const b = files[rel];
    if (!b || !b.exists || b.sha256 !== sha(buf)) out.push(rel);
  }
  for (const rel of Object.keys(files)) if (rel.startsWith(SECRETS_REL + '/') && !status.includes(path.basename(rel)) && files[rel].exists && !fs.existsSync(path.join(root, rel))) out.push(rel);
  return out;
}
function snapshot(root) {
  const dir = path.join(root, SECRETS_REL); const m = {};
  let names = []; try { names = fs.readdirSync(dir); } catch (_) {}
  for (const n of names) { try { m[n] = sha(fs.readFileSync(path.join(dir, n))); } catch (_) {} }
  return m;
}

/* D: { root, MME, station(path, body, ms), prov: {wrote, callerConflict, ownerShell}, seats: {ceo, people}, nameToId(name),
 *      nameOf(id), decide(by, text), now } */
async function setEndpoint(D, o) {
  if (String(o.provider || '') !== 'minimax') throw refuse('set-endpoint takes minimax (the only provider with an endpoint choice)', 'input');
  const byRaw = String(o.by || '').trim(); if (!byRaw || byRaw === 'true') throw refuse('--by <Name> is required', 'input');
  let who;
  if (byRaw.toLowerCase() === 'owner') { if (!D.prov.ownerShell()) throw refuse('"--by owner" is accepted ' + require('./lib/owner').REASON); who = { id: 'owner', name: 'owner' }; }
  else {
    const id = D.nameToId(byRaw); if (!id) throw refuse('--by must be someone on the crew', 'input');
    if (id !== D.seats.ceo && id !== D.seats.people) throw refuse(D.nameOf(id) + ' may not change provider settings: the CEO (' + D.nameOf(D.seats.ceo) + ') or the people seat (' + D.nameOf(D.seats.people) + ') applies an owner-approved one');
    const c = D.prov.callerConflict(D.root, [WRITER, 'set-endpoint', byRaw], id, D.now());
    if (c) throw refuse('this command claims --by ' + byRaw + ' but ran in another seat\'s run (' + c.runId + ')');
    who = { id, name: D.nameOf(id) };
  }
  const ep = D.MME.resolve({ region: o.region || 'global', baseUrl: o['base-url'], other: o.other === true });
  if (!ep.ok) throw refuse(ep.error, 'input');
  const host = new URL(ep.baseUrl).hostname;
  const qid = String(o.approval || '').trim(); if (!/^q-\d+$/.test(qid)) throw refuse('--approval <q-id> is required: the owner question that approved this endpoint', 'input');
  const ap = approvalFor(readLines(path.join(D.root, 'company', 'pm-inbox.jsonl')), qid, host);
  if (ap.error) throw refuse(ap.error);
  const cfgFile = path.join(D.root, 'company', 'company.json'); const cfg = readJson(cfgFile, null);
  if (!cfg) throw refuse('company/company.json is missing or not JSON', 'state');
  const cur = cfg.providers && cfg.providers.minimax;
  if (cur && cur.approval === qid && D.MME.same(D.MME.fromConfig(cfg), ep)) throw refuse(qid + ' is already applied (company.json providers.minimax)', 'state');
  const pending = unreviewed(D.root, readJson(path.join(D.root, 'company', 'state', 'locked', 'baseline.json'), null));
  if (pending.length) throw refuse('the station key store has ' + pending.length + ' change(s) the watcher has not accepted (' + pending.map(p => path.basename(p)).join(', ') + '): the owner accepts or rotates them first (Settings, or locked-watch.js accept), then run this again', 'state');
  const key = D.MME.storedKey(D.root); if (!key) throw refuse('no MiniMax key on file (secrets/minimax-key or the station store): the owner sets the key in Settings first', 'state');
  const scrub = s => String(s == null ? '' : s).split(key).join('[key]').slice(0, 160);
  const v = await D.station('providers/validate', { provider: 'custom', key, baseUrl: ep.baseUrl }, 25000);
  if (!v.ok || !v.data || !v.data.credentialVerified) throw refuse('MiniMax at ' + host + ' did not accept the key on file' + (v.data && v.data.reachable === false ? ' (not reachable from the station)' : v.error ? ' (' + scrub(v.error) + ')' : '') + '; nothing was changed', 'station');
  if (o['dry-run']) return { ok: true, dryRun: true, by: who.name, approval: qid, endpoint: { region: ep.region, baseUrl: ep.baseUrl }, warnings: ep.warnings };
  const before = snapshot(D.root);
  let c = await D.station('providers/connect', { provider: 'custom', key, baseUrl: ep.baseUrl }, 50000);
  if (!(c.ok && c.data && c.data.ok)) {
    if (c.data && c.data.code && c.data.code !== 'no-page') throw refuse('the station did not save the endpoint: ' + scrub(c.data.error), 'station');
    c = await D.station('providers/engine-key', { provider: 'custom', key, baseUrl: ep.baseUrl }, 20000);
    if (!(c.ok && c.data && c.data.ok)) throw refuse('the station did not save the endpoint: ' + scrub((c.data && c.data.error) || c.error || 'HTTP ' + c.status), 'station');
  }
  // the station wrote its key store: record exactly the files it changed, so the watcher accepts those bytes
  const after = snapshot(D.root); const recorded = [];
  for (const [n, h] of Object.entries(after)) if (before[n] !== h) { const f = path.join(D.root, SECRETS_REL, n); D.prov.wrote(f, fs.readFileSync(f), WRITER); recorded.push(n); }
  cfg.providers = Object.assign({}, cfg.providers || {}, { minimax: Object.assign(D.MME.entryOf(ep, who.name), { approval: qid }) });
  const text = JSON.stringify(cfg, null, 2) + '\n';
  writeAtomic(cfgFile, text); D.prov.wrote(cfgFile, text, WRITER);
  D.decide(who.name, 'set the MiniMax endpoint to ' + D.MME.plain(ep) + ' (' + ep.baseUrl + ') through the station, as the owner approved in ' + qid + ' (company/tools/providers.js)');
  return { ok: true, by: who.name, approval: qid, endpoint: { region: ep.region, baseUrl: ep.baseUrl }, recorded, warnings: ep.warnings };
}

/* ---- live wiring ---- */
function liveDeps() {
  const co = require('./lib/company'); const prov = require('./provenance.js'); const MME = require('./lib/minimax-endpoint.js');
  const crew = co.crew();
  return {
    root: co.ROOT, MME, prov, now: () => Date.now(),
    seats: { ceo: co.ceo(), people: co.seatFor('people') },
    nameToId: n => (Object.entries(crew).find(([, s]) => String((s && s.name) || '').toLowerCase() === String(n).toLowerCase()) || [])[0] || null,
    nameOf: id => co.nameOf(id),
    decide: (by, text) => { const r = require('./decision.js').add({ by, text }); if (r && r.error) console.error('providers: the decision was not recorded: ' + r.error); },
    station: (p, body, ms) => new Promise(resolve => {
      const token = co.stationToken(); if (!token) return resolve({ ok: false, error: 'no station token' });
      let u; try { u = new URL(co.STATION_URL + '/api/' + p); } catch (e) { return resolve({ ok: false, error: e.message }); }
      const data = JSON.stringify(body || {});
      const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'x-starnet-token': token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
        let d = ''; res.on('data', x => { d += x; }); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} resolve({ ok: res.statusCode === 200, status: res.statusCode, data: j, error: j ? undefined : 'not JSON' }); });
      });
      req.setTimeout(ms || 15000, () => req.destroy(new Error('station timeout')));
      req.on('error', e => resolve({ ok: false, error: 'station unreachable: ' + e.message }));
      req.end(data);
    }),
  };
}

/* ---- selftest: a scratch company, a fake station that writes its key store like StarNet does ---- */
async function selftest() {
  const assert = require('assert'); const os = require('os');
  const MME = require('./lib/minimax-endpoint.js');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'providers-selftest-'));
  const w = (rel, v) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v)); return f; };
  w('company/company.json', { name: 'Test Co' });
  w('secrets/minimax-key', 'sk-test-key-123456');
  const store = SECRETS_REL + '/provider-keys.json';
  w(store, { providers: { custom: { key: 'sk-test-key-123456' } } });
  const base = () => w('company/state/locked/baseline.json', { files: Object.fromEntries(fs.readdirSync(path.join(T, SECRETS_REL)).map(n => [SECRETS_REL + '/' + n, { exists: true, sha256: sha(fs.readFileSync(path.join(T, SECRETS_REL, n))) }])) });
  base();
  const inbox = rows => w('company/pm-inbox.jsonl', rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const ASK = { type: 'ask', id: 'q-100001', from: 'Alex', q: 'May we use https://api.minimax.io/v1 as the MiniMax base URL?' };
  const YES = { type: 'answer', id: 'q-100001', at: '2030-01-01T00:00:00Z', a: 'yes', answer: { verdict: 'yes', action: 'approve' }, by: 'Pat' };
  const calls = []; const wrote = []; const decided = [];
  let accept = true, conflict = null;
  const D = {
    root: T, MME, now: () => 0, seats: { ceo: 'ceo1', people: 'hr1' },
    nameToId: n => ({ alex: 'ceo1', hana: 'hr1', sam: 'w1' })[String(n).toLowerCase()] || null,
    nameOf: id => ({ ceo1: 'Alex', hr1: 'Hana', w1: 'Sam' })[id] || id,
    prov: { wrote: (f, b, by) => wrote.push({ f: path.relative(T, f), sha: sha(Buffer.from(b)), by }), callerConflict: () => conflict, ownerShell: () => false },
    decide: (by, text) => decided.push({ by, text }),
    station: async (p, body) => {
      calls.push({ p, baseUrl: body.baseUrl });
      if (p === 'providers/validate') return { ok: true, data: { credentialVerified: accept, reachable: true } };
      if (p === 'providers/connect') { w(store, { providers: { custom: { key: body.key, baseUrl: body.baseUrl } } }); w(SECRETS_REL + '/provider-keys.json.bak', 'old'); return { ok: true, data: { ok: true } }; }
      return { ok: false, status: 404 };
    },
  };
  const run = o => setEndpoint(D, Object.assign({ provider: 'minimax', region: 'global', by: 'Alex', approval: 'q-100001' }, o));
  const refused = async (o, re, label) => { let e = null; try { await run(o); } catch (x) { e = x; } assert.ok(e && re.test(e.message), label + ' -> ' + (e && e.message)); };
  const ok = [];
  const t = async (name, fn) => { await fn(); ok.push(name); console.log('ok   ' + name); };
  try {
    inbox([ASK]);
    await t('refused without an answer, and without --approval', async () => { await refused({}, /no answer/, 'unanswered'); await refused({ approval: '' }, /--approval/, 'missing'); });
    inbox([ASK, Object.assign({}, YES, { answer: { verdict: 'no' } })]);
    await t('refused when the owner said no', () => refused({}, /not answered yes/, 'no'));
    inbox([ASK, YES]);
    await t('an approval for one address is not one for another (cn host)', () => refused({ region: 'cn' }, /does not name api\.minimaxi\.com/, 'other host'));
    await t('only the CEO or the people seat; a claimed --by from another run is refused', async () => {
      await refused({ by: 'Sam' }, /may not change provider settings/, 'worker');
      conflict = { runId: 'r9' }; await refused({}, /another seat's run/, 'conflict'); conflict = null;
      await refused({ by: 'owner' }, /owner's own interactive shell/, 'owner off-shell');
    });
    await t('a key not accepted on the new endpoint changes nothing', async () => {
      accept = false; await refused({}, /did not accept/, 'reject'); accept = true;
      assert.ok(!calls.some(c => c.p === 'providers/connect') && !(readJson(path.join(T, 'company/company.json'), {}).providers));
    });
    await t('a hand edit of the key store not yet accepted blocks the tool (it is never blessed by a later run)', async () => {
      w(store, { providers: { custom: { key: 'sk-test-key-123456', baseUrl: 'https://hand.example/v1' } } });
      await refused({}, /has 1 change\(s\) the watcher has not accepted \(provider-keys\.json\)/, 'hand edit');
      w(store, { providers: { custom: { key: 'sk-test-key-123456' } } }); base();
    });
    await t('the station rewriting its readiness file (status, not key material) does not block the tool', async () => {
      w(SECRETS_REL + '/provider-readiness.json', { version: 1, providers: { custom: { status: 'verified', lastVerified: 2 } } });
      const r = await run({ 'dry-run': true }); assert.ok(r.dryRun);
    });
    await t('dry run: validated on the station, nothing written', async () => {
      const r = await run({ 'dry-run': true });
      assert.ok(r.dryRun && !calls.some(c => c.p === 'providers/connect') && !wrote.length);
    });
    await t('apply: through the station API, the changed store files recorded, company.json written, a decision added', async () => {
      const r = await run({});
      assert.deepStrictEqual(calls.filter(c => c.p === 'providers/connect').map(c => c.baseUrl), ['https://api.minimax.io/v1']);
      assert.deepStrictEqual(r.recorded.sort(), ['provider-keys.json', 'provider-keys.json.bak']);
      const storeSha = sha(fs.readFileSync(path.join(T, store)));
      assert.ok(wrote.some(x => x.f === store && x.sha === storeSha && x.by === WRITER), JSON.stringify(wrote));
      const cfg = readJson(path.join(T, 'company/company.json'), {});
      assert.ok(cfg.providers.minimax.region === 'global' && cfg.providers.minimax.approval === 'q-100001' && cfg.providers.minimax.setBy === 'Alex');
      assert.ok(wrote.some(x => x.f === 'company/company.json' && x.by === WRITER));
      assert.ok(decided.length === 1 && /q-100001/.test(decided[0].text) && !JSON.stringify(decided).includes('sk-test'));
    });
    await t('the same approval is not applied twice', async () => { base(); await refused({}, /already applied/, 'twice'); });
    await t('the key never appears in a refusal', async () => {
      D.station = async p => p === 'providers/validate' ? { ok: false, error: 'bad key sk-test-key-123456' } : { ok: false };
      let e = null; try { await run({ approval: 'q-100001', region: 'global', 'dry-run': true }); } catch (x) { e = x; }
      assert.ok(e && !/sk-test/.test(e.message));
    });
  } catch (e) { console.log('FAIL ' + (e && e.message)); fs.rmSync(T, { recursive: true, force: true }); console.log('SELFTEST FAILED'); return 1; }
  fs.rmSync(T, { recursive: true, force: true });
  console.log('all ' + ok.length + ' checks passed');
  return 0;
}

if (require.main === module) {
  const a = process.argv.slice(2); const o = { _: [] };
  for (let i = 0; i < a.length; i++) { if (a[i].startsWith('--')) { const k = a[i].slice(2); o[k] = a[i + 1] !== undefined && !a[i + 1].startsWith('--') ? a[++i] : true; } else o._.push(a[i]); }
  const cmd = o._[0];
  (async () => {
    if (cmd === 'selftest' || o.selftest) process.exit(await selftest());
    if (cmd === 'show') { const ep = require('./lib/minimax-endpoint.js').read(require('./lib/company').ROOT); console.log(JSON.stringify({ region: ep.region, baseUrl: ep.baseUrl, stored: ep.stored, problem: ep.problem || null }, null, 1)); return; }
    if (cmd === 'set-endpoint') { const r = await setEndpoint(liveDeps(), Object.assign({}, o, { provider: o._[1] })); console.log(JSON.stringify(r, null, 1)); return; }
    console.error('usage: providers.js set-endpoint minimax --region global|cn|custom [--base-url URL] [--other] --by <Name> --approval <q-id> [--dry-run] | show | selftest'); process.exit(2);
  })().catch(e => { console.error('providers: ' + e.message); process.exit(e && e.code === 'station' ? 1 : 2); });
}
module.exports = { setEndpoint, approvalFor, unreviewed };
