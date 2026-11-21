'use strict';
/* apprentice/client.js — the direct HTTP client to the apprentice model server (docs/APPRENTICE.md). It is not a station
 * provider and never runs as a seat: no tools are ever offered, nothing it returns is acted on.
 *
 *   const C = require('./client')
 *   const c = C.makeClient({ root, cfg, key })     cfg: the apprentice config (baseUrl, tenant, namespace, timeouts)
 *   await c.health() / c.ready() / c.models()
 *   await c.chat(model, messages, { purpose, unitId }) -> { text, tokensIn, tokensOut, servedModel }
 *   await c.submitTrajectory(lesson) / c.study() / c.units() / c.promote(unitId, o) / c.rollback(unitId, o) / c.exportCapheos(unitId)
 *       -> { status, json, text }   (never throws on an HTTP status; throws on a refused send, a timeout or a network error)
 *   C.apprenticeDriver({ client, model, unitId, deadline }) -> a model bench driver (packs/model-bench lib/bench.js run)
 *
 * Every request body goes through the outbound secret scrub (lib/outbound-scrub.js with lib/secret-patterns.json and the
 * values in <root>/secrets/), rebuilt when the secrets folder changes. When the scrub throws, nothing is sent. Every
 * reply text is scrubbed too. Only the configured host is ever contacted: no redirects are followed, a reply over
 * maxResponseBytes is cut off and refused, each request has a timeout. The key goes only in the Authorization header.
 */
const path = require('path');
const http = require('http');
const https = require('https');
const S = require('../outbound-scrub');
const A = require('./adapter');

const PATTERNS = path.join(__dirname, '..', 'secret-patterns.json');

function makeScrub(root) {
  const dir = path.join(root, 'secrets');
  let sig = null, sc = null;
  return () => {
    const s = S.dirSignature(dir);
    if (!sc || s !== sig) { const P = S.loadPatterns(PATTERNS); sc = S.makeScrubber({ patterns: P, values: S.valuesFromDir(dir, P.minValueLen) }); sig = s; }
    return sc;
  };
}

function makeClient(o) {
  o = o || {};
  const cfg = o.cfg || {}, root = o.root;
  if (!root) throw new Error('apprentice client: no company root');
  let base;
  try { base = new URL(String(cfg.baseUrl || '')); } catch (_) { throw new Error('apprentice client: no baseUrl configured (company/state/apprentice.json baseUrl)'); }
  if (!/^https?:$/.test(base.protocol)) throw new Error('apprentice client: baseUrl must be http or https');
  const host = base.host, lib = base.protocol === 'https:' ? https : http;
  const timeoutMs = Number(cfg.requestTimeoutSec) > 0 ? Number(cfg.requestTimeoutSec) * 1000 : 120000;
  const maxBytes = Number(cfg.maxResponseBytes) > 0 ? Number(cfg.maxResponseBytes) : 2 * 1024 * 1024;
  const scrub = o.scrubber ? () => o.scrubber : makeScrub(root);
  const P = A.paths(cfg), tenant = cfg.tenant;
  const stats = { requests: 0, redacted: 0, refusedSends: 0 };

  function request(method, rel, body, ro) {
    ro = ro || {};
    return new Promise((resolve, reject) => {
      let payload = null;
      if (body !== undefined) {
        try { const counts = {}; const clean = scrub().body(body, counts); stats.redacted += S.total(counts); payload = JSON.stringify(clean); }
        catch (e) { stats.refusedSends++; reject(new Error('not sent: the outbound scrub failed (' + String(e.message || e).slice(0, 120) + ')')); return; }
      }
      const u = new URL(rel, base);
      if (u.host !== host || u.protocol !== base.protocol) { reject(new Error('not sent: only the configured apprentice host is contacted')); return; }
      const headers = { Accept: 'application/json, text/event-stream' };
      if (o.key) headers.Authorization = 'Bearer ' + o.key;
      if (payload != null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
      stats.requests++;
      const req = lib.request({ protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method, headers }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400) { res.resume(); reject(new Error('apprentice replied with a redirect (' + res.statusCode + '); redirects are not followed')); return; }
        const chunks = []; let n = 0, over = false;
        res.on('data', c => { if (over) return; n += c.length; if (n > maxBytes) { over = true; req.destroy(); reject(new Error('apprentice reply over ' + maxBytes + ' bytes; refused')); return; } chunks.push(c); });
        res.on('end', () => {
          if (over) return;
          const raw = Buffer.concat(chunks).toString('utf8');
          const text = scrub().text(raw);
          let json = null; try { json = JSON.parse(text); } catch (_) {}
          resolve({ status: res.statusCode, json, text: text.slice(0, ro.keepText ? maxBytes : 4000), sse: /text\/event-stream/.test(String(res.headers['content-type'] || '')) ? text : null });
        });
        res.on('error', reject);
      });
      req.setTimeout(Math.max(1000, Math.min(timeoutMs, Number(ro.timeoutMs) || timeoutMs)), () => req.destroy(new Error('apprentice request timed out')));
      req.on('error', e => reject(new Error(String(e.message || e).slice(0, 200))));
      if (payload != null) req.write(payload);
      req.end();
    });
  }

  async function chat(model, messages, co) {
    co = co || {};
    const body = A.chatBody(model, messages, Object.assign({ candidateTarget: cfg.candidateTarget, maxTokens: cfg.maxTokens }, co));
    const r = await request('POST', P.chat, body, { keepText: true, timeoutMs: co.timeoutMs });
    if (r.status !== 200) throw new Error('apprentice chat HTTP ' + r.status + ' ' + String(r.text || '').slice(0, 160));
    const out = A.chatReply(r.sse != null ? r.sse : r.json);
    if (!out.text && r.json == null && r.sse == null) throw new Error('apprentice chat reply is not json');
    return out;
  }
  return {
    stats, host,
    health: () => request('GET', P.health),
    ready: () => request('GET', P.ready),
    models: () => request('GET', P.models),
    chat,
    submitTrajectory: lesson => request('POST', P.trajectories(tenant), A.trajectoryBody(lesson)),
    study: so => request('POST', P.study(tenant), A.studyBody(so)),
    units: () => request('GET', P.units(tenant)),
    promote: (unitId, d) => request('POST', P.promote(tenant, unitId), A.decisionBody(d)),
    rollback: (unitId, d) => request('POST', P.rollback(tenant, unitId), A.decisionBody(d)),
    exportCapheos: unitId => request('POST', P.exportUnit(tenant, unitId), {}),
  };
}

/* a model bench driver over the client: one answer per turn, no tools (the bench's kinds 1, 2 and 5 at lookup and simple
   are sandbox none with no tools). A turn past the deadline throws and marks the driver out of time, so the caller can
   tell a cut-short run from a weak one and decide nothing on it. */
function apprenticeDriver(d) {
  return {
    id: d.label || d.model, family: 'apprentice', outOfTime: false, calls: 0,
    start() {},
    async turn(messages) {
      if (d.deadline && Date.now() > d.deadline) { this.outOfTime = true; throw new Error('the apprentice study budget ran out'); }
      this.calls++;
      const r = await d.client.chat(d.model, messages, { purpose: 'bench', unitId: d.unitId });
      return { text: r.text, tokensIn: r.tokensIn, tokensOut: r.tokensOut, servedModel: r.servedModel, usd: 0 };
    },
  };
}

module.exports = { makeClient, apprenticeDriver, makeScrub, PATTERNS };
