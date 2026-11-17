'use strict';
/* lib/station.js — the one way CaPheOS reads an answer from StarNet's routine API (/api/cron, /api/cron/update,
 * /api/cron/remove, /api/cron/arm).
 *
 * Why: StarNet answers some refusals with HTTP 200. The mint gate remembers routine names (also of routines deleted
 * since) and declines a re-use with 200 {ok:false, declined:true, message:"this routine already exists — do not
 * recreate it"}; nothing is created. A caller that reads `status === 200` as success then reports "done" for a routine
 * that does not exist. Every routine create/update/remove/arm goes through cronResult()/cron(), and every create
 * through createRoutine(), which also reads GET /api/cron back and fails with the station's reason when the routine is
 * not there.
 *
 *   ST.cronResult(res, what)              -> { ok, status, json, declined, duplicate, reason }   (pure)
 *   await ST.cron(call, method, path, body, what)   one call, judged by cronResult (a thrown call is a failure)
 *   await ST.createRoutine(call, spec, { what, rename, attempts, acceptDuplicate })
 *                                         POST /api/cron, then GET /api/cron must list it. On a decline (or a duplicate
 *                                         answer) with `rename(name)` given, it retries under rename's new name.
 *                                         -> { ok, job, name, reason, tries: [reason…] }
 *   ST.suffix(bytes) / ST.uniqueName(base, bytes)   random hex, "<base> #<hex>": a name the dedupe memory has never seen
 *                                         (lanes.js "Lane <8 hex>", the watchdog "… #<6 hex>")
 * `call(method, path, body)` is any station caller answering { status, body } (station-crew.js) or { status, json,
 * text|error } (founder-loop.js stationCall). Test seam: CAPHEOS_ROUTINE_SUFFIXES=a,b,… hands those suffixes out first.
 */
const crypto = require('crypto');

function parse(res) {
  if (!res) return null;
  if (res.json !== undefined && res.json !== null) return res.json;
  if (typeof res.body === 'string') { try { return JSON.parse(res.body); } catch (_) { return null; } }
  if (res.body && typeof res.body === 'object') return res.body;
  return null;
}
const said = (json, res) => String((json && (json.message || json.error || json.reason)) || (res && (res.text || (typeof res.body === 'string' ? res.body : '') || res.error)) || '').replace(/\s+/g, ' ').trim().slice(0, 200);

function cronResult(res, what) {
  what = what || 'station';
  if (!res) return { ok: false, status: 0, json: null, declined: false, duplicate: false, reason: what + ': no answer from the station' };
  const status = Number(res.status) || 0, json = parse(res);
  const base = { status, json, declined: !!(json && json.declined === true), duplicate: !!(json && json.duplicate === true) };
  if (status !== 200) return Object.assign(base, { ok: false, reason: what + ': ' + (status ? 'HTTP ' + status : 'no answer') + (said(json, res) ? ' ' + said(json, res) : '') });
  if (json && (json.ok === false || json.declined === true)) return Object.assign(base, { ok: false, reason: what + ': the station declined (HTTP 200)' + (said(json, res) ? ': ' + said(json, res) : '') });
  return Object.assign(base, { ok: true, reason: what + ': HTTP 200' });
}
async function cron(call, method, p, body, what) {
  let res; try { res = await call(method, p, body); } catch (e) { return { ok: false, status: 0, json: null, declined: false, duplicate: false, reason: (what || method + ' ' + p) + ': ' + String((e && e.message) || e).slice(0, 200) }; }
  return cronResult(res, what || method + ' ' + p);
}

const queued = () => String(process.env.CAPHEOS_ROUTINE_SUFFIXES || '').split(',').map(s => s.trim()).filter(Boolean);
let handed = 0;
function suffix(bytes) {
  const q = queued(); if (handed < q.length) return q[handed++];
  return crypto.randomBytes(bytes || 3).toString('hex');
}
const uniqueName = (base, bytes) => String(base) + ' #' + suffix(bytes || 3);

async function listJobs(call) {
  const r = await cron(call, 'GET', '/api/cron', null, 'GET /api/cron');
  return r.ok && r.json && Array.isArray(r.json.jobs) ? { ok: true, jobs: r.json.jobs } : { ok: false, reason: r.ok ? 'GET /api/cron: no routine list in the answer' : r.reason };
}

async function createRoutine(call, spec, o) {
  o = o || {};
  const what = o.what || 'create "' + spec.name + '"';
  const attempts = Math.max(1, o.attempts || (o.rename ? 2 : 1));
  const tries = []; let body = Object.assign({}, spec);
  for (let i = 0; i < attempts; i++) {
    const r = await cron(call, 'POST', '/api/cron', body, what + (i ? ' (retry as "' + body.name + '")' : ''));
    let fail = null;
    const job = r.json && r.json.job;
    if (!r.ok) fail = r.reason;
    else if (!job || !job.id) fail = r.reason.replace(/: HTTP 200$/, '') + ': the station created nothing (no routine in its answer)';
    else if (!o.acceptDuplicate && (r.duplicate || (job.name != null && job.name !== body.name))) fail = r.reason.replace(/: HTTP 200$/, '') + ': the station answered with its existing routine "' + job.name + '" instead of creating "' + body.name + '"';
    if (!fail) {
      const l = await listJobs(call);
      if (!l.ok) fail = what + ': could not read the routine back (' + l.reason + ')';
      else if (!l.jobs.some(x => x && x.id === job.id)) fail = what + ': the station answered ' + (r.json && r.json.message ? '"' + said(r.json) + '"' : 'HTTP 200') + ' but GET /api/cron does not list routine ' + job.id;
      else return { ok: true, job, name: body.name, duplicate: r.duplicate, reason: what + ': created ' + job.id + (i ? ' as "' + body.name + '"' : ''), tries };
    }
    tries.push(fail);
    const retryable = r.declined || r.duplicate || /existing routine/.test(fail);
    if (!(o.rename && retryable && i + 1 < attempts)) break;
    body = Object.assign({}, body, { name: o.rename(body.name) });
  }
  return { ok: false, job: null, name: body.name, reason: tries[tries.length - 1], tries };
}

module.exports = { cronResult, cron, createRoutine, listJobs, suffix, uniqueName, _parse: parse };
