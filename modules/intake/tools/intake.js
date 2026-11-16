#!/usr/bin/env node
/* intake.js — inbound signals: webhooks pushed at the console server and feeds pulled by pollers, normalised into one
 * Event shape and appended to company/work/intake/events.jsonl with a dedupe key.
 *
 *   Event: { id, at, source, type, key, party?, data, receivedVia }      (docs/CORE-MODULES.md "Shared shapes")
 *
 * Webhooks: POST /hooks/intake/<source> (mounted by the console server from modules/intake/http.js). Per source a
 * secret in secrets/intake/<source> (0600). The request must carry X-Intake-Timestamp (unix seconds, ms or ISO; within
 * the replay window, 300 s) and EITHER `Authorization: Bearer <secret>` OR `X-Intake-Signature: sha256=<hex>` where
 * hex = HMAC-SHA256(secret, "<timestamp>.<raw body>"). Body cap 256 KB. Dedupe key: X-Intake-Key header, else body
 * .key / .id, else the body's sha256. Type: X-Intake-Type header, else body .type, else "event". A source with no
 * secret does not exist (401, same as a bad signature, so sources cannot be probed).
 * Pollers: company/work/intake/pollers/<name>.json, contract in modules/intake/docs/POLLERS.md; one shipped kind,
 * `json-feed`. Every fetch is an external-gate `network` check (allowlisted hosts only).
 * Limits (kit.limits: company/state/modules/<id>/limits/ once the owner opens them; shipped closed): eventsPerDayPerSource (outside events: webhooks and pollers),
 * maxPollers. Internal events (observe, a tool) are not capped: they are the company talking to itself.
 *
 *   node company/tools/intake.js ingest --source <s> --type <t> [--key <k>] [--party <id>] [--data '<json>'] [--json]
 *   node company/tools/intake.js list [--source <s>] [--since <ISO>] [--limit N] [--json]
 *   node company/tools/intake.js poll [--dry] [--json]
 *   node company/tools/intake.js sign --source <s> --body '<raw>'     # prints the headers a sender must set (test aid)
 *   node company/tools/intake.js --selftest
 * Module: require('./intake.js') -> { ingest, normalise, verifyRequest, handleHook, poll, list, POLLERS, EVENTS }.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const LIB = [path.join(__dirname, 'lib'), path.join(__dirname, '..', '..', '..', 'company', 'tools', 'lib')].find(d => fs.existsSync(path.join(d, 'modkit.js')));
const co = require(path.join(LIB, 'company'));
const kit = require(path.join(LIB, 'modkit'));

const MAX_BODY = 256 * 1024;
const WINDOW_S = 300;
const SRC_RE = /^[a-z][a-z0-9-]{1,39}$/;
const DIR = () => co.p('company', 'work', 'intake');
const EVENTS = () => path.join(DIR(), 'events.jsonl');
const KEYS = () => path.join(DIR(), 'keys.json');
const COUNTS = () => path.join(DIR(), 'counts.json');
const POLL_DIR = () => path.join(DIR(), 'pollers');
const POLL_STATE = () => path.join(DIR(), 'pollers-state.json');
const REFUSED = () => path.join(DIR(), 'refused.jsonl');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function normalise(source, body, o) {
  o = o || {};
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : { value: body };
  const raw = o.raw != null ? String(o.raw) : JSON.stringify(b);
  const key = String(o.key || b.key || b.id || sha(raw).slice(0, 32)).slice(0, 200);
  const party = o.party || (typeof b.party === 'string' ? b.party : null);
  const ev = { id: kit.newId('ev'), at: new Date(o.now || Date.now()).toISOString(), source, type: String(o.type || b.type || 'event').slice(0, 80), key,
    data: b.data !== undefined && Object.keys(b).every(k => ['key', 'id', 'type', 'party', 'data'].includes(k)) ? b.data : b, receivedVia: o.via || 'tool' };
  if (party && /^[a-z][a-z0-9-]{1,39}$/.test(party)) ev.party = party;
  return ev;
}

/* Append one event unless its key was seen. external = counts against eventsPerDayPerSource. */
function ingest(ev, o) {
  o = o || {};
  if (!SRC_RE.test(String(ev.source))) throw new Error('bad source id: ' + ev.source);
  const keys = co.readJson(KEYS(), {}) || {};
  const k = ev.source + ':' + ev.key;
  if (keys[k]) return { ok: true, dedupe: true, firstAt: keys[k] };
  if (o.external) {
    const cap = kit.limit('intake', 'eventsPerDayPerSource');
    const day = ev.at.slice(0, 10); const counts = co.readJson(COUNTS(), {}) || {};
    const n = (counts[day] && counts[day][ev.source]) || 0;
    if (n >= cap) { kit.appendJsonl(REFUSED(), { at: ev.at, source: ev.source, key: ev.key, why: 'eventsPerDayPerSource ' + cap }); return { ok: false, refused: true, error: 'the intake limit eventsPerDayPerSource is ' + cap + ' (limits ship closed; the owner opens them)' }; }
    const keep = {}; keep[day] = Object.assign({}, counts[day], { [ev.source]: n + 1 });
    if (!o.dry) kit.writeJson(COUNTS(), keep);
  }
  if (o.dry) return { ok: true, dry: true, event: ev };
  kit.appendJsonl(EVENTS(), ev);
  keys[k] = ev.at;
  const cutoff = Date.now() - 30 * 86400000;
  for (const x of Object.keys(keys)) if (Date.parse(keys[x]) < cutoff) delete keys[x];
  kit.writeJson(KEYS(), keys);
  return { ok: true, event: ev };
}

function tsOk(v, now) {
  if (!v) return false;
  let t = /^\d+(\.\d+)?$/.test(String(v)) ? Number(v) : Date.parse(v) / 1000;
  if (t > 1e11) t = t / 1000;   // ms
  return Number.isFinite(t) && Math.abs(now / 1000 - t) <= WINDOW_S;
}
function verifyRequest({ source, headers, raw, now }) {
  now = now || Date.now(); headers = headers || {};
  const h = k => headers[k] || headers[k.toLowerCase()];
  if (!SRC_RE.test(String(source || ''))) return { ok: false, status: 404, error: 'no such source' };
  const secret = co.secret('intake/' + source);
  if (!secret) return { ok: false, status: 401, error: 'unauthorised' };
  const ts = h('x-intake-timestamp');
  if (!tsOk(ts, now)) return { ok: false, status: 401, error: 'missing or stale X-Intake-Timestamp (replay window ' + WINDOW_S + ' s)' };
  const auth = String(h('authorization') || '');
  const sig = String(h('x-intake-signature') || '');
  if (auth.startsWith('Bearer ') && same(auth.slice(7).trim(), secret)) return { ok: true, via: 'webhook-token' };
  if (sig.startsWith('sha256=') && same(sig.slice(7), crypto.createHmac('sha256', secret).update(ts + '.' + raw).digest('hex'))) return { ok: true, via: 'webhook-hmac' };
  return { ok: false, status: 401, error: 'unauthorised' };
}

function readRaw(req, ctx) {
  // the console mount hands the raw body over as ctx.body (a Buffer, already capped at 256 KB)
  for (const b of [ctx && ctx.body, ctx && ctx.rawBody]) if (typeof b === 'string' || Buffer.isBuffer(b)) return Promise.resolve(Buffer.from(b));
  return new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { const e = new Error('body too large (cap ' + MAX_BODY + ' bytes)'); e.status = 413; reject(e); req.destroy(); return; } parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts))); req.on('error', reject);
  });
}
function send(res, status, o) { const b = JSON.stringify(o); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(b) }); res.end(b); }
/* The webhook handler (http.js). The source comes from ctx.params.source, else the last path segment. */
async function handleHook(req, res, ctx) {
  ctx = ctx || {};
  const seg = String((ctx.params && ctx.params.source) || new URL(req.url, 'http://x').pathname.split('/').filter(Boolean).pop() || '');
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' });
  const len = Number(req.headers['content-length'] || 0);
  if (len > MAX_BODY) return send(res, 413, { ok: false, error: 'body too large (cap ' + MAX_BODY + ' bytes)' });
  let raw; try { raw = await readRaw(req, ctx); } catch (e) { return send(res, e.status || 400, { ok: false, error: e.message }); }
  if (raw.length > MAX_BODY) return send(res, 413, { ok: false, error: 'body too large' });
  const text = raw.toString('utf8');
  const v = verifyRequest({ source: seg, headers: req.headers, raw: text });
  if (!v.ok) { kit.appendJsonl(REFUSED(), { at: new Date().toISOString(), source: SRC_RE.test(seg) ? seg : '(bad)', why: v.error }); return send(res, v.status === 404 ? 401 : v.status, { ok: false, error: v.error === 'no such source' ? 'unauthorised' : v.error }); }
  let body; try { body = text.trim() ? JSON.parse(text) : {}; } catch (_) { body = { text }; }
  const ev = normalise(seg, body, { raw: text, key: req.headers['x-intake-key'], type: req.headers['x-intake-type'], via: v.via });
  const r = ingest(ev, { external: true });
  if (!r.ok) return send(res, 429, { ok: false, error: r.error });
  return send(res, 202, { ok: true, id: r.event ? r.event.id : null, dedupe: !!r.dedupe });
}

/* ---------- pollers ---------- */
async function gatedFetch(url, o) {
  o = o || {};
  if (!o.gate) {
    const gate = kit.tool('external-gate');
    if (!gate) throw new Error('external-gate.js missing: network refused (fail closed)');
    const d = gate.check({ category: 'network', target: url, agent: 'intake', note: 'intake poller ' + (o.name || '') });
    if (!d.allow) throw new Error('external gate refused ' + url + ': ' + d.reason);
  } else if (!o.gate(url)) throw new Error('gate refused ' + url);
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), o.timeoutMs || 15000);
  try {
    const r = await fetch(url, { headers: Object.assign({ accept: 'application/json' }, o.headers || {}), signal: ctl.signal });
    const txt = await r.text();
    if (txt.length > 2 * 1024 * 1024) throw new Error('feed larger than 2 MB');
    return { status: r.status, text: txt };
  } finally { clearTimeout(t); }
}
const POLLERS = {
  /* json-feed: GET a JSON document, take the array at `items` (dot path, default the root), one event per item with
   * key = item[`key`] (default "id"), type = cfg.type (default "item"). Optional `secret`: name under secrets/intake/
   * sent as a bearer token. */
  'json-feed': async (cfg, st, env) => {
    const headers = {}; if (cfg.secret) { const s = co.secret('intake/' + cfg.secret); if (!s) throw new Error('secret intake/' + cfg.secret + ' missing'); headers.authorization = 'Bearer ' + s; }
    const r = await env.fetch(cfg.url, { headers, name: cfg.name });
    if (r.status < 200 || r.status > 299) throw new Error('feed answered ' + r.status);
    const doc = JSON.parse(r.text);
    const items = kit.dget(doc, cfg.items || '');
    if (!Array.isArray(items)) throw new Error('feed has no array at "' + (cfg.items || '(root)') + '"');
    return { events: items.map(it => ({ type: cfg.type || 'item', key: String(kit.dget(it, cfg.key || 'id') != null ? kit.dget(it, cfg.key || 'id') : sha(JSON.stringify(it)).slice(0, 32)), data: it, party: cfg.party })), state: { lastCount: items.length } };
  },
};
function pollerConfigs() {
  let fs_ = []; try { fs_ = fs.readdirSync(POLL_DIR()).filter(f => /^[a-z][a-z0-9-]{1,39}\.json$/.test(f)).sort(); } catch (_) {}
  return fs_.map(f => Object.assign({ name: f.replace(/\.json$/, '') }, co.readJson(path.join(POLL_DIR(), f), {})));
}
async function poll(o) {
  o = o || {};
  const now = o.now || Date.now(); const log = o.log || (() => {});
  const state = co.readJson(POLL_STATE(), {}) || {};
  const max = kit.limit('intake', 'maxPollers');
  const out = [];
  const cfgs = pollerConfigs();
  cfgs.forEach((cfg, i) => { if (i >= max) out.push({ name: cfg.name, skipped: 'over the maxPollers limit (' + max + ')' }); });
  for (const cfg of cfgs.slice(0, max)) {
    const st = state[cfg.name] || {};
    const every = Math.max(1, Number(cfg.every) || 60) * 60000;
    if (st.lastAt && now - Date.parse(st.lastAt) < every) { out.push({ name: cfg.name, skipped: 'not due' }); continue; }
    const kind = POLLERS[cfg.kind];
    if (!kind) { out.push({ name: cfg.name, error: 'unknown poller kind ' + cfg.kind }); continue; }
    if (!SRC_RE.test(String(cfg.source || ''))) { out.push({ name: cfg.name, error: 'bad source' }); continue; }
    try {
      const r = await kind(cfg, st, { fetch: (u, x) => gatedFetch(u, Object.assign({ gate: o.gate }, x)), now });
      let added = 0, dup = 0, refused = 0;
      for (const e of r.events || []) {
        const ev = normalise(cfg.source, { data: e.data }, { key: e.key, type: e.type, party: e.party, via: 'poller:' + cfg.name, now });
        const x = ingest(ev, { external: true, dry: o.dry });
        if (x.dedupe) dup++; else if (x.ok) added++; else refused++;
      }
      state[cfg.name] = Object.assign({}, r.state, { lastAt: new Date(now).toISOString(), lastOk: true, added });
      out.push({ name: cfg.name, added, dedupe: dup, refused });
      log('INTAKE poller ' + cfg.name + ': ' + added + ' new, ' + dup + ' seen, ' + refused + ' refused');
    } catch (e) {
      state[cfg.name] = Object.assign({}, st, { lastAt: new Date(now).toISOString(), lastOk: false, error: e.message });
      out.push({ name: cfg.name, error: e.message }); log('INTAKE poller ' + cfg.name + ' failed: ' + e.message);
    }
  }
  if (!o.dry) kit.writeJson(POLL_STATE(), state);
  return { ok: true, pollers: out };
}
function list(o) {
  o = o || {};
  let l = kit.readJsonl(EVENTS()).filter(e => (!o.source || e.source === o.source) && (!o.since || e.at >= o.since));
  if (o.limit) l = l.slice(-Number(o.limit));
  return l;
}

module.exports = { ingest, normalise, verifyRequest, handleHook, poll, list, POLLERS, EVENTS, MAX_BODY, WINDOW_S };

async function selftest(ok) {
  const http = require('http');
  fs.mkdirSync(path.join(co.ROOT, 'secrets', 'intake'), { recursive: true });
  fs.writeFileSync(path.join(co.ROOT, 'secrets', 'intake', 'shop'), 's3cret\n', { mode: 0o600 });
  const ts = () => String(Math.floor(Date.now() / 1000));
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/hooks/intake/')) return handleHook(req, res, {});
    if (req.url === '/feed') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ items: [{ id: 'a1', v: 1 }, { id: 'a2', v: 2 }] })); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const post = async (src, body, headers) => { const r = await fetch(base + '/hooks/intake/' + src, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), body }); return { status: r.status, json: await r.json().catch(() => null) }; };
  const body = JSON.stringify({ id: 'order-1', type: 'order.created', total: 12 });
  let r = await post('shop', body, { authorization: 'Bearer s3cret', 'x-intake-timestamp': ts() });
  ok('closed limit refuses an outside event (429)', r.status === 429, r);
  kit.setLimits(co.ROOT, 'intake', { eventsPerDayPerSource: 3, maxPollers: 1 });
  r = await post('shop', body, { authorization: 'Bearer s3cret', 'x-intake-timestamp': ts() });
  ok('bearer token accepted (202)', r.status === 202 && r.json.ok && !r.json.dedupe, r);
  r = await post('shop', body, { authorization: 'Bearer s3cret', 'x-intake-timestamp': ts() });
  ok('same key deduped', r.status === 202 && r.json.dedupe === true, r);
  const b2 = JSON.stringify({ id: 'order-2', type: 'order.created' }); const t2 = ts();
  r = await post('shop', b2, { 'x-intake-timestamp': t2, 'x-intake-signature': 'sha256=' + crypto.createHmac('sha256', 's3cret').update(t2 + '.' + b2).digest('hex') });
  ok('HMAC signature accepted', r.status === 202 && r.json.ok, r);
  r = await post('shop', b2.replace('2', '3'), { 'x-intake-timestamp': t2, 'x-intake-signature': 'sha256=' + crypto.createHmac('sha256', 's3cret').update(t2 + '.' + b2).digest('hex') });
  ok('tampered body refused (401)', r.status === 401, r);
  r = await post('shop', body, { authorization: 'Bearer wrong', 'x-intake-timestamp': ts() });
  ok('wrong token refused (401)', r.status === 401, r);
  r = await post('shop', body, { authorization: 'Bearer s3cret', 'x-intake-timestamp': String(Math.floor(Date.now() / 1000) - 3600) });
  ok('stale timestamp refused (replay window)', r.status === 401 && /stale/.test(r.json.error), r);
  r = await post('shop', body, { authorization: 'Bearer s3cret' });
  ok('missing timestamp refused', r.status === 401, r);
  r = await post('nosuch', body, { authorization: 'Bearer s3cret', 'x-intake-timestamp': ts() });
  ok('unknown source looks like a bad secret (401)', r.status === 401 && r.json.error === 'unauthorised', r);
  r = await post('shop', JSON.stringify({ id: 'big', pad: 'x'.repeat(MAX_BODY) }), { authorization: 'Bearer s3cret', 'x-intake-timestamp': ts() });
  ok('body over 256 KB refused (413)', r.status === 413, r);
  const evs = list();
  const e0 = evs[0] || {};
  ok('Event shape', evs.length === 2 && ['id', 'at', 'source', 'type', 'key', 'data', 'receivedVia'].every(k => k in e0) && e0.type === 'order.created' && e0.key === 'order-1' && e0.receivedVia === 'webhook-token', e0);
  // poller
  fs.mkdirSync(path.join(co.ROOT, 'company', 'work', 'intake', 'pollers'), { recursive: true });
  fs.writeFileSync(path.join(co.ROOT, 'company', 'work', 'intake', 'pollers', 'feed.json'), JSON.stringify({ kind: 'json-feed', source: 'feed', url: base + '/feed', items: 'items', key: 'id', type: 'feed.item', every: 5 }));
  fs.writeFileSync(path.join(co.ROOT, 'company', 'work', 'intake', 'pollers', 'zfeed.json'), JSON.stringify({ kind: 'json-feed', source: 'feed', url: base + '/feed' }));
  const F = x => x.pollers.find(y => y.name === 'feed') || {};
  let p = await poll({ gate: () => false });
  ok('a poller fetch the gate refuses is an error, not events', F(p).error && /refused/.test(F(p).error), p);
  fs.rmSync(path.join(co.ROOT, 'company', 'work', 'intake', 'pollers-state.json'));
  p = await poll({ gate: () => true });
  ok('json-feed poller adds one event per item', F(p).added === 2 && list({ source: 'feed' }).length === 2, p);
  ok('maxPollers holds the second poller', /maxPollers/.test(p.pollers.find(x => x.name === 'zfeed').skipped || ''), p);
  p = await poll({ gate: () => true });
  ok('not due before its cadence', F(p).skipped === 'not due');
  p = await poll({ gate: () => true, now: Date.now() + 6 * 60000 });
  ok('polled again after its cadence: all deduped', F(p).dedupe === 2 && F(p).added === 0, p);
  ok('internal ingest is not capped', ingest(normalise('observe', { data: { x: 1 } }, { key: 'k1', type: 'observe.change' })).ok);
  srv.close();
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest') || argv[0] === 'selftest') { kit.runSelftest(__filename, 'intake', selftest); return; }
  const a = kit.args(argv);
  const out = (o, text) => console.log(a.json ? JSON.stringify(o, null, 2) : text);
  const cmd = a._[0];
  (async () => {
    if (cmd === 'ingest') {
      let data = {}; if (a.data) data = JSON.parse(a.data);
      const r = ingest(normalise(a.source, { data }, { key: a.key, type: a.type, party: a.party, via: 'cli' }));
      out(r, r.dedupe ? 'seen before' : 'ingested ' + r.event.id);
    } else if (cmd === 'list') { const l = list({ source: a.source, since: a.since, limit: a.limit || 50 }); out(l, l.map(e => e.at + '  ' + e.source + '  ' + e.type + '  ' + e.key).join('\n') || '(no events)'); }
    else if (cmd === 'poll') { const r = await poll({ dry: !!(a.dry || a['dry-run']), log: console.log }); out(r, JSON.stringify(r.pollers)); }
    else if (cmd === 'sign') { const s = co.secret('intake/' + a.source); if (!s) throw new Error('no secret intake/' + a.source); const t = String(Math.floor(Date.now() / 1000)); out({ 'X-Intake-Timestamp': t, 'X-Intake-Signature': 'sha256=' + crypto.createHmac('sha256', s).update(t + '.' + (a.body || '')).digest('hex') }, 'X-Intake-Timestamp: ' + t + '\nX-Intake-Signature: sha256=' + crypto.createHmac('sha256', s).update(t + '.' + (a.body || '')).digest('hex')); }
    else { console.error('usage: intake.js ingest|list|poll|sign|--selftest (see header)'); process.exit(2); }
  })().catch(e => { console.error(e.message); process.exit(1); });
}
