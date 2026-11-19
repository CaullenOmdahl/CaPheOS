'use strict';
/* console/profile.js — the owner's Crew › <person> › Profile tab (docs/PROFILES.md; the tool is company/tools/profile.js).
 * Mounted by console/server.js: require('./profile.js').mount(route, { run, runApi, bad, HttpError, owner }).
 *
 *   GET  /api/profile/presets                   the console's presets (company/defaults/people/presets.json)
 *   GET  /api/profile/<seat>                    profile.js show <seat> --console: the profile (owner notes included: the
 *                                               console is the owner's), the last 30 history rows, open proposals, the
 *                                               trial, the rendered preview and the owner's sentences
 *   POST /api/profile/<seat>/preview { set }    the preview of unsaved changes (nothing written)
 *   POST /api/profile/<seat>        { set, base, why, now? }   profile.js edit … --by <owner>
 *   POST /api/profile/<seat>/undo   { to }
 *   POST /api/profile/<seat>/try    { set, base, days }
 *   POST /api/profile/<seat>/trial/keep | /trial/stop
 *   POST /api/profile/proposals/<pp-id>/apply | decline | try
 *   POST /api/profile/policy        { inject: charter|profile }   "Use profiles for this company" (owner only)
 *   POST /api/profile/<seat>/migrate              build this seat's first profile from its charter
 * `set` is an object { "<json pointer>": <value> }. A stale `base` (someone changed the profile meanwhile) is a 409 in
 * plain words. Every write runs the tool with --by <owner>; nothing here writes a company file itself.
 */
const SEAT = /^[A-Za-z0-9_.:-]{1,80}$/;
const PTR = /^\/[A-Za-z][A-Za-z0-9_/~-]{0,120}$/;
const CONFLICT = 'Someone changed this profile while you were editing it. Reload to see the latest version, then make your change again.';

function mount(route, d) {
  const { run, runApi, bad, HttpError, owner } = d;
  const seatOf = v => { const s = String(v || ''); if (!SEAT.test(s) || s.startsWith('-')) bad('bad seat'); return s; };
  const setArgs = set => {
    if (!set || typeof set !== 'object' || Array.isArray(set)) bad('set must be an object of { pointer: value }');
    const out = [];
    for (const [k, v] of Object.entries(set)) { if (!PTR.test(k)) bad('bad field ' + k); out.push('--set', k + '=' + JSON.stringify(v === undefined ? null : v)); }
    if (!out.length) bad('nothing to change');
    if (out.length > 80) bad('too many changes at once');
    return out;
  };
  const base = b => { const n = Number(b && b.base); if (!Number.isInteger(n) || n < 1) bad('base (the version you are changing) is required'); return ['--base', String(n)]; };
  // like runApi, but a stale base is a 409 the owner can read
  async function write(args) {
    const r = await run('profile.js', args, { timeout: 30000 });
    const j = r.data || {};
    if (r.code === 0 && j.ok !== false) return Object.assign({ ok: true }, j);
    if (r.code === 4 || j.conflict) throw new HttpError(409, CONFLICT, { version: j.version });
    throw new HttpError(r.code === 3 ? 403 : r.code === 2 ? 400 : 500, j.error || j.text || 'not saved', j);
  }
  route('GET', /^\/api\/profile\/presets$/, () => {
    const P = require('../company/tools/lib/profile.js');
    return { ok: true, presets: P.presets({ root: require('../company/tools/lib/company.js').ROOT }) };
  });
  route('POST', /^\/api\/profile\/policy$/, (m, q, b) => {
    const v = String((b && b.inject) || ''); if (!['charter', 'profile'].includes(v)) bad('inject is charter or profile');
    return write(['policy', 'inject', v, '--by', owner()]);
  });
  route('POST', /^\/api\/profile\/proposals\/(pp-[0-9a-f]{8})\/(apply|decline|try)$/, (m, q, b) => write(['decide', m[1], m[2], '--by', owner()].concat(b && Number.isInteger(Number(b.days)) && Number(b.days) > 0 ? ['--days', String(Number(b.days))] : [])));
  route('GET', /^\/api\/profile\/([A-Za-z0-9_.:-]{1,80})$/, m => runApi('profile.js', ['show', seatOf(m[1]), '--console'], { timeout: 20000 }));
  route('POST', /^\/api\/profile\/([A-Za-z0-9_.:-]{1,80})\/preview$/, (m, q, b) => {
    const s = seatOf(m[1]); const set = b && b.set && Object.keys(b.set).length ? setArgs(b.set) : [];
    return runApi('profile.js', ['render', s, '--preview'].concat(set), { timeout: 20000 });
  });
  route('POST', /^\/api\/profile\/([A-Za-z0-9_.:-]{1,80})\/migrate$/, m => write(['migrate', '--seat', seatOf(m[1]), '--by', owner()]));
  route('POST', /^\/api\/profile\/([A-Za-z0-9_.:-]{1,80})\/undo$/, (m, q, b) => {
    const to = Number(b && b.to); if (!Number.isInteger(to) || to < 1) bad('to (the version to go back to) is required');
    return write(['undo', seatOf(m[1]), '--to', String(to), '--by', owner()]);
  });
  route('POST', /^\/api\/profile\/([A-Za-z0-9_.:-]{1,80})\/try$/, (m, q, b) => {
    const days = Math.max(1, Math.min(60, Number(b && b.days) || 7));
    return write(['try', seatOf(m[1])].concat(setArgs(b && b.set), base(b), ['--days', String(days), '--by', owner()], b && b.why ? ['--why', String(b.why).replace(/[\r\n]+/g, ' ').slice(0, 300)] : []));
  });
  route('POST', /^\/api\/profile\/([A-Za-z0-9_.:-]{1,80})\/trial\/(keep|stop)$/, m => write(['trial', m[2], seatOf(m[1]), '--by', owner()]));
  route('POST', /^\/api\/profile\/([A-Za-z0-9_.:-]{1,80})$/, (m, q, b) => write(['edit', seatOf(m[1])].concat(setArgs(b && b.set), base(b), ['--by', owner()],
    b && b.now === true ? ['--now'] : [], b && b.why ? ['--why', String(b.why).replace(/[\r\n]+/g, ' ').slice(0, 300)] : [])));
}
module.exports = { mount, CONFLICT };
