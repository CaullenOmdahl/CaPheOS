#!/usr/bin/env node
/* offpeak-clocks.js — does any routine own a clock inside a provider's peak-price blocks?
 *
 * Why: paid DeepSeek work should run in the cheap window. The peak blocks are a pricing fact of the provider, kept in
 * company/work/finance/pacing-policy.json `peakPricing.deepseek` in the provider's own timezone (lib/models-money.js).
 * Moving clocks once is a repair; this is the check that catches the next routine added inside a peak block.
 *
 *   node company/tools/offpeak-clocks.js                 # read GET /api/cron; exit 1 on any clock inside peak
 *   node company/tools/offpeak-clocks.js --json          # findings as JSON
 *   node company/tools/offpeak-clocks.js --file <jobs>   # read a saved /api/cron body instead of the station
 *   node company/tools/offpeak-clocks.js --selftest      # fixture jobs; exit 1 if it cannot see an in-peak clock
 *
 * What it does NOT flag, on purpose:
 *   - routines that run more than once a day (hourly, every 2 hours): they cannot be outside peak without being
 *     turned off;
 *   - routines on the must-not-move list (pacing-policy.json offpeakHold.mustNotMove, prefix match; the same list the
 *     peak hold in offpeak-hold.js uses). A missing list exempts everything; an empty list exempts nothing;
 *   - days the provider does not price as peak (weekends, for DeepSeek): nothing to move.
 *
 * A routine's clock is read in its own schedule timezone (schedule.tz, else the company timezone) and converted to
 * the provider's timezone before it is compared. The configured margin either side of each block counts as peak,
 * because the provider does not say whether a request that crosses a boundary bills at its start or its end.
 *
 * Exit: 0 every movable clock is off-peak, 1 at least one is inside peak, 2 cannot read the station or the file.
 * Owner: the tools seat (co.seatFor('tools')); wired into the daily tool health routine.
 */
'use strict';
const fs = require('fs');
const http = require('http');
const co = require('./lib/company');
const mm = require('./lib/models-money');
const OH = require('./offpeak-hold.js');

const pad2 = n => String(n).padStart(2, '0');
const hm = min => pad2(Math.floor(min / 60)) + ':' + pad2(min % 60);

// A job's single-time clock in minutes, or null when it runs more than once a day (cannot be moved off peak).
function singleClock(job) {
  const sch = job && job.schedule;
  if (!sch || sch.kind !== 'cron') return null;
  const h = (sch.fields && sch.fields.hour) || [];
  const m = (sch.fields && sch.fields.minute) || [];
  if (h.length !== 1 || m.length !== 1) return null;
  return { at: h[0] * 60 + m[0], hour: h[0], minute: m[0] };
}

// the must-not-move prefix that exempts this job, `true` when the list is missing (everything exempt), else null
function exempt(job, root) {
  const name = String((job && job.name) || '');
  const list = mm.mustNotMove(root);
  if (list == null) return true;
  return list.find((p) => p && name.toLowerCase().startsWith(String(p).toLowerCase())) || null;
}

// True only when the routine names a provider and it is not deepseek. An unset provider stays a finding:
// the lane is unknown, and a quiet skip is how a DeepSeek wake would escape the check.
function otherLane(job) {
  const p = String((job && job.provider) || '').toLowerCase();
  return !!p && p.indexOf('deepseek') === -1;
}

// the instant a single daily clock fires on the day of `now`, both read in the job's own timezone
function clockInstant(job, clock, now) {
  const tz = (job && job.schedule && job.schedule.tz) || co.TZ;
  const [y, mo, d] = mm.zoneParts(now.getTime(), tz).date.split('-').map(Number);
  return mm.zonedMs(tz, y, mo, d, clock.hour, clock.minute);
}

// the peak block (in the provider's timezone, with margin) that this instant falls in, or null
function inPeak(ms, cfg) {
  const c = cfg || OH.peakConfig();
  const p = OH.peakBlock(ms, undefined, c);
  return p.peak ? p.block : null;
}

function audit(jobs, now, opts) {
  opts = opts || {};
  const day = now || new Date();
  const cfg = opts.cfg || OH.peakConfig(opts.root);
  const findings = [];
  if (!cfg.known) return findings;             // no peak hours configured: nothing can be inside one
  for (const job of jobs || []) {
    if (job && job.enabled === false) continue;
    if (otherLane(job)) continue;              // peak is a DeepSeek price; a subscription lane costs the same at any hour
    const clock = singleClock(job);
    if (!clock) continue;                      // hourly / multi-time: a move cannot help
    if (exempt(job, opts.root)) continue;      // the must-not-move list
    const block = inPeak(clockInstant(job, clock, day), cfg);
    if (!block) continue;                      // includes days the provider does not price as peak
    findings.push({
      code: 'clock-in-peak',
      id: job.id,
      name: job.name,
      at: pad2(clock.hour) + ':' + pad2(clock.minute) + ' ' + ((job.schedule && job.schedule.tz) || co.TZ),
      block: block.slice(0, 2) + ':' + block.slice(2, 4) + '–' + block.slice(5, 7) + ':' + block.slice(7, 9) + ' ' + cfg.timezone,
      fix: 'move it outside the peak blocks (' + cfg.blocks.map(([a, b]) => hm(a) + '–' + hm(b)).join(', ') + ' ' + cfg.timezone + '), at least ' + cfg.marginMin + ' minutes clear of a boundary',
    });
  }
  return findings;
}

function stationJobs(cb) {
  let tok = ''; try { tok = co.stationToken(); } catch (e) { return cb(e); }
  const u = new URL(co.STATION_URL + '/api/cron');
  const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', headers: { 'x-starnet-token': tok }, timeout: 15000 }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => { try { cb(null, (JSON.parse(body).jobs) || []); } catch (e) { cb(e); } });
  });
  req.on('error', (e) => cb(e));
  req.on('timeout', () => { req.destroy(new Error('timed out')); });
  req.end();
}

function report(findings, jobs, opts) {
  if (opts.json) { process.stdout.write(JSON.stringify(findings, null, 1) + '\n'); }
  else {
    for (const f of findings) process.stdout.write('clock-in-peak  ' + f.at + '  "' + f.name + '" — inside ' + f.block + ' (margin included): ' + f.fix + '\n');
  }
  const movable = (jobs || []).filter((j) => singleClock(j) && !exempt(j, opts.root) && !otherLane(j)).length;
  if (findings.length) { process.stdout.write('OFF-PEAK CLOCKS: FAIL (' + findings.length + ' of ' + movable + ' movable clock(s) inside peak)\n'); return 1; }
  process.stdout.write('OFF-PEAK CLOCKS: OK (' + movable + ' movable clock(s), none inside peak)\n');
  return 0;
}

function selftest() {
  const os = require('os'), path = require('path');
  // a fixture root and config, so the result does not depend on the numbers in the policy file
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offpeak-clocks-selftest-'));
  fs.mkdirSync(path.join(root, path.dirname(mm.POLICY_REL)), { recursive: true });
  fs.writeFileSync(path.join(root, mm.POLICY_REL), JSON.stringify({ offpeakHold: { mustNotMove: ['Daily standup', 'Ops loop'] } }));
  const cfg = mm.normalisePeak('deepseek', { timezone: 'Asia/Shanghai', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], blocks: [['09:00', '12:00'], ['14:00', '18:00']], marginMin: 10 });
  const TZ = 'Etc/GMT-7';   // the routines' own clock is UTC+7, one hour behind the provider's UTC+8
  const job = (id, name, expr, fields) => ({ id, name, enabled: true, schedule: { kind: 'cron', expr, fields, tz: TZ } });
  const one = (h, m) => ({ hour: [h], minute: [m], dayOfWeek: [0, 1, 2, 3, 4, 5, 6], dayOfMonth: [] });
  const every = (h, m) => ({ hour: h, minute: [m], dayOfWeek: [0, 1, 2, 3, 4, 5, 6], dayOfMonth: [] });
  const weekday = new Date(mm.zonedMs(TZ, 2026, 11, 16, 4, 0));   // Monday
  const saturday = new Date(mm.zonedMs(TZ, 2026, 11, 21, 4, 0));
  // provider peak 09:00-12:00 and 14:00-18:00 UTC+8 = 08:00-11:00 and 13:00-17:00 on the routines' UTC+7 clock
  const jobs = [
    job('a', 'Floor loop', '0 8 * * *', one(8, 0)),                  // 08:00 = inside, on the boundary
    job('b', 'Tool health check', '40 11 * * *', one(11, 40)),       // gap between blocks = clean
    job('c', 'Research loop', '40 12 * * *', one(12, 40)),           // gap, 20 clear of the next block = clean
    job('d', 'Security sweep', '5 12 * * *', one(12, 5)),            // clean
    job('e', 'Something at 12:55', '55 12 * * *', one(12, 55)),      // INSIDE the 10-minute margin
    job('f', 'Something at 13:05', '5 13 * * *', one(13, 5)),        // INSIDE the block
    job('g', 'Something at 17:20', '20 17 * * *', one(17, 20)),      // after the block + margin = clean
    job('h', 'Ops loop — run the company', '0 * * * *', every([0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23], 0)),   // exempt + hourly
    job('i', 'Daily standup', '0 9 * * *', one(9, 0)),               // must-not-move
    job('j', 'Disabled one', '0 9 * * *', one(9, 0)),                // enabled:false below
  ];
  jobs[9].enabled = false;
  jobs.push(Object.assign(job('k', 'Subscription lane at 09:00', '0 9 * * *', one(9, 0)), { provider: 'claude-cli', model: 'sonnet' }));
  jobs.push(Object.assign(job('l', 'DeepSeek lane at 09:00', '0 9 * * *', one(9, 0)), { provider: 'deepseek', model: 'deepseek-flash' }));
  jobs.push(job('m', 'Unset lane at 09:00', '0 9 * * *', one(9, 0)));
  const opts = { root, cfg };
  const got = audit(jobs, weekday, opts).map((f) => f.name).sort();
  const want = ['DeepSeek lane at 09:00', 'Floor loop', 'Something at 12:55', 'Something at 13:05', 'Unset lane at 09:00'].sort();
  let pass = 0, fail = 0;
  const ok = (name, cond, extra) => { if (cond) { pass++; process.stdout.write('ok    ' + name + '\n'); } else { fail++; process.stdout.write('FAIL  ' + name + (extra ? ' — ' + extra : '') + '\n'); } };
  ok('an 08:00 (UTC+7) clock is inside the 09:00 (UTC+8) block', got.includes('Floor loop'));
  ok('12:40 and 12:05 are between the blocks and clean', !got.includes('Research loop') && !got.includes('Security sweep'));
  ok('12:55 and 13:05 are inside the margin or the block', got.includes('Something at 12:55') && got.includes('Something at 13:05'));
  ok('17:20 is after the margin and clean', !got.includes('Something at 17:20'));
  ok('the hourly Ops loop and Daily standup are exempt', !got.includes('Ops loop — run the company') && !got.includes('Daily standup'));
  ok('a disabled routine is not a finding', !got.includes('Disabled one'));
  ok('a claude-cli routine inside peak is not a finding (not DeepSeek-billed)', !got.includes('Subscription lane at 09:00'));
  ok('a deepseek routine and an unset-lane routine inside peak are findings', got.includes('DeepSeek lane at 09:00') && got.includes('Unset lane at 09:00'));
  ok('exactly the five expected findings', got.length === want.length && got.every((g, i) => g === want[i]), JSON.stringify(got));
  ok('the weekend has nothing to move', audit(jobs, saturday, opts).length === 0);
  ok('the same clock in the provider timezone is judged the same way', audit([Object.assign(job('n', 'Provider tz', '30 9 * * *', one(9, 30)), { schedule: { kind: 'cron', fields: one(9, 30), tz: 'Asia/Shanghai' } })], weekday, opts).length === 1);
  ok('no peak config flags nothing', audit(jobs, weekday, { root, cfg: mm.normalisePeak('deepseek', null) }).length === 0);
  fs.writeFileSync(path.join(root, mm.POLICY_REL), JSON.stringify({ offpeakHold: { mustNotMove: [] } }));
  ok('an empty must-not-move list exempts nothing', audit(jobs, weekday, opts).some((f) => f.name === 'Daily standup'));
  fs.writeFileSync(path.join(root, mm.POLICY_REL), JSON.stringify({ offpeakHold: {} }));
  ok('a missing must-not-move list exempts everything', audit(jobs, weekday, opts).length === 0);
  fs.rmSync(root, { recursive: true, force: true });
  process.stdout.write('\nOFF-PEAK CLOCKS SELFTEST: ' + pass + ' passed, ' + fail + ' failed\n');
  return fail === 0 ? 0 : 1;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('usage: node company/tools/offpeak-clocks.js [--json|--selftest] [--file <saved /api/cron body>]\n');
    return 0;
  }
  const opts = { json: argv.includes('--json') };
  const fi = argv.indexOf('--file');
  if (fi >= 0 && argv[fi + 1]) {
    let jobs;
    try { jobs = JSON.parse(fs.readFileSync(argv[fi + 1], 'utf8')).jobs; } catch (e) {
      process.stderr.write('offpeak-clocks: cannot read ' + argv[fi + 1] + ': ' + e.message + '\n');
      return 2;
    }
    return report(audit(jobs), jobs, opts);
  }
  // Async path: the exit code is produced by the callback, so main() returns nothing and the caller must not exit.
  stationJobs((err, jobs) => {
    if (err) { process.stderr.write('offpeak-clocks: cannot read the station (/api/cron): ' + err.message + '\n'); process.exit(2); }
    process.exit(report(audit(jobs), jobs, opts));
  });
  return null;
}

if (require.main === module) {
  const code = main(process.argv.slice(2));
  if (typeof code === 'number') process.exit(code);   // the station path exits from its own callback
}

module.exports = { audit, singleClock, inPeak, exempt, clockInstant, mustNotMove: root => mm.mustNotMove(root) };
