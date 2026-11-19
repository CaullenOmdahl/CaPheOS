#!/usr/bin/env node
/* security-watch.test.js — the security watch (company/tools/security-watch.js, docs/SECURITY-WATCH.md), offline.
 *
 * Recorded fixtures only (company/tools/tests/fixtures/security-watch/: the real station lockfile trimmed, real OSV
 * records, a real npm audit answer), a fake GitHub (no issue is ever created for real), captured owner notices, temp
 * company folders. Covers: parsers, the P0/P1/P2/P3 rules, the sharp/librsvg first fixture and its mitigation, dedupe of
 * one advisory across places and of one GitHub issue across companies, nothing about the company in an issue, the gate
 * refusing an issue (CEO asked once), the npm audit fallback, offline tolerance and the overdue check, mitigate/hold
 * rules, the read-only duty, the plain owner notice through the real owner-notice (strict), and the deps.js fast track.
 *
 *   node --test company/tools/tests/security-watch.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const SW = require(path.join(REPO, 'company', 'tools', 'security-watch.js'));
const FX = path.join(__dirname, 'fixtures', 'security-watch');
// temp dirs go with company/tools/lib/temp-life.js: removed however the run ends (also on the runner's timeout)
const life = require(path.join(REPO, 'company', 'tools', 'lib', 'temp-life.js'));
const tmp = p => life.tmpDir(p);
test.after(() => life.cleanup());
const fixture = (extra) => { const t = SW.buildFixtureRoot(tmp('secwatch-test-'), FX); Object.assign(t.opts, extra || {}); t.ctx = SW.ctxOf(t.opts); return t; };
const at = (t, ms) => Object.assign({}, t.opts, { now: ms });

test('parsers: npm lock v3 (dev, other-platform optional), requirements pins, dpkg by source package, apk, os-release', () => {
  const comps = SW.parseNpmLock(fs.readFileSync(path.join(FX, 'station-package-lock.json'), 'utf8'), { platform: 'linux', arch: 'x64' });
  const by = n => comps.find(x => x.name === n && !x.path.includes('kokoro-js/node_modules'));
  assert.equal(by('sharp').version, '0.35.4');
  assert.equal(by('@img/sharp-libvips-darwin-arm64').platformOnly, true);
  assert.equal(by('@img/sharp-linux-x64').platformOnly, false);
  assert.equal(by('@napi-rs/canvas').dev, true);
  assert.equal(comps.find(x => x.path === 'node_modules/kokoro-js/node_modules/@huggingface/transformers').via, 'kokoro-js');
  assert.deepEqual(SW.parsePyReq('requests==2.32.3 --hash=sha256:ab\n# c\nflask>=3\nNumPy[extra] == 2.1.0\n-r other.txt\n').map(x => x.name + '@' + x.version), ['requests@2.32.3', 'NumPy@2.1.0']);
  assert.deepEqual(SW.osRelease('ID=debian\nVERSION_ID="12"\nPRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n'), { eco: 'Debian:12', name: 'Debian GNU/Linux 12 (bookworm)' });
  assert.equal(SW.osRelease('ID=cachyos\nNAME="CachyOS Linux"').eco, null);
  const dp = SW.parseDpkg('Package: libssl3\nStatus: install ok installed\nSource: openssl\nVersion: 3.0.15-1~deb12u1\n\nPackage: gone\nStatus: deinstall ok config-files\nVersion: 1\n', 'Debian:12');
  assert.deepEqual(dp.map(x => x.name + '@' + x.version), ['openssl@3.0.15-1~deb12u1']);
  assert.deepEqual(SW.parseApk('P:libcrypto3\nV:3.3.2-r0\no:openssl\n\nP:musl\nV:1.2.5-r0\n', 'Alpine:v3.20').map(x => x.name), ['openssl', 'musl']);
});

test('severity and the fixed release come from the advisory record', () => {
  const v = JSON.parse(fs.readFileSync(path.join(FX, 'osv', 'GHSA-wq5f-xc86-pv6w.json'), 'utf8'));
  assert.equal(SW.severityOf(v), 'HIGH');
  assert.equal(SW.fixedFor(v, 'npm', 'sharp', '0.35.4'), '0.35.5');
  assert.equal(SW.canonicalId(v), 'GHSA-wq5f-xc86-pv6w');
  const fu = JSON.parse(fs.readFileSync(path.join(FX, 'osv', 'GHSA-333x-w4r6-6crp.json'), 'utf8'));
  assert.equal(SW.fixedFor(fu, 'npm', 'fast-uri', '3.1.7'), '3.1.9', 'the range the version is in, not the 2.x or 4.x fix');
  assert.equal(SW.fixedFor(fu, 'npm', 'fast-uri', '4.0.1'), '4.2.3');
  assert.equal(SW.severityOf({ severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }] }), 'CRITICAL');
  assert.equal(SW.cvss3Score('CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:L/A:N'), 3.7);
});

// the P0 rule, on synthetic records over the fixture inventory
test('levels: P0 = serious + really used here + a fix or exploited; critical with no fix = P0 mitigate; high no fix = P1; build-only = P2; other platform = P3', () => {
  const t = fixture();
  const inv = SW.inventory(t.ctx);
  const rec = (id, name, sev, fixed, extra) => Object.assign({ id, summary: id, aliases: [], database_specific: { severity: sev }, affected: [{ package: { ecosystem: 'npm', name }, ranges: [{ type: 'SEMVER', events: fixed ? [{ introduced: '0' }, { fixed }] : [{ introduced: '0' }] }] }] }, extra || {});
  const recs = { A: rec('A', 'sharp', 'HIGH', '0.35.5'), B: rec('B', 'kokoro-js', 'HIGH', null), C: rec('C', 'ajv', 'CRITICAL', null), D: rec('D', '@napi-rs/canvas', 'CRITICAL', '9.9.9'), E: rec('E', '@img/sharp-libvips-darwin-arm64', 'CRITICAL', '9.9.9'), K: rec('K', 'fast-uri', 'HIGH', null, { aliases: ['CVE-2024-12345'] }) };
  const hits = new Map(); const key = x => x.eco + '|' + x.name + '|' + x.version;
  for (const x of inv.components) { const r = Object.values(recs).find(v => v.affected[0].package.name === x.name); if (r) hits.set(key(x), [{ id: r.id }]); }
  const fs_ = SW.buildFindings(t.ctx, SW.policy(t.ctx), inv, { hits, recs }, [], new Set(['CVE-2024-12345']));
  const lv = n => { const f = fs_.find(x => x.name === n); return f && f.level + '/' + f.action; };
  assert.equal(lv('sharp'), 'P0/fix');
  assert.equal(lv('kokoro-js'), 'P1/mitigate');
  assert.equal(lv('ajv'), 'P0/mitigate');
  assert.equal(lv('@napi-rs/canvas'), 'P2/fix');
  assert.equal(lv('@img/sharp-libvips-darwin-arm64'), 'P3/watch');
  assert.equal(lv('fast-uri'), 'P0/mitigate', 'exploited in the wild with no fix: P0, mitigate now');
  assert.deepEqual(fs_.find(x => x.name === 'sharp').issueRepos, ['example/framework']);
  assert.deepEqual(fs_.find(x => x.name === 'ajv').issueRepos, ['example/framework']);
});

test('one advisory found in two places is one finding with two locations', () => {
  const t = fixture();
  const inv = SW.inventory(t.ctx);
  const v = { id: 'GHSA-xxxx-yyyy-zzzz', aliases: ['CVE-2026-1'], summary: 's', database_specific: { severity: 'HIGH' }, affected: [{ package: { ecosystem: 'npm', name: '@huggingface/transformers' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.2.1' }] }] }] };
  const alias = { id: 'PYSEC-nope', aliases: ['GHSA-xxxx-yyyy-zzzz'], summary: 's', database_specific: { severity: 'HIGH' }, affected: v.affected };
  const hits = new Map();
  for (const x of inv.components.filter(x => x.name === '@huggingface/transformers')) hits.set(x.eco + '|' + x.name + '|' + x.version, [{ id: v.id }, { id: alias.id }]);
  const out = SW.buildFindings(t.ctx, SW.policy(t.ctx), inv, { hits, recs: { [v.id]: v, [alias.id]: alias } }, [], new Set());
  const f = out.filter(x => x.name === '@huggingface/transformers');
  assert.equal(f.length, 1, JSON.stringify(out.map(x => x.id + ' ' + x.advisory)));
  assert.deepEqual(f[0].locations.map(l => l.version).sort(), ['3.8.1', '4.2.0']);
  assert.equal(f[0].fixed, '4.2.1');
});

test('the first fixture end to end: sharp/librsvg is P0, the report and the duty carry what to do, the SVG mitigation is named', async () => {
  const t = fixture();
  await SW.refresh(Object.assign({}, t.opts, { force: true }));
  const S = SW.readState(t.ctx);
  const f = Object.values(S.findings).find(x => x.name === 'sharp');
  assert.equal(f.level, 'P0'); assert.equal(f.fixed, '0.35.5'); assert.equal(f.severity, 'HIGH');
  assert.match(f.mitigation.how, /sharp\.block\(\{ operation: \["VipsForeignLoadSvg"\] \}\)/);
  assert.match(f.mitigation.how, /image\.js fitToSize/);
  const report = fs.readFileSync(path.join(t.opts.root, SW.REPORT_REL), 'utf8');
  assert.match(report, new RegExp(f.id + ' — P0 sharp \\(GHSA-wq5f-xc86-pv6w\\)'));
  assert.match(report, /Station: bump sharp to 0\.35\.5 in the station checkout/);
  assert.match(report, /restart-station\.js/);
  const d = SW.duty(t.opts);
  assert.equal(d.code, 1); assert.equal(d.out.priority, 'P0'); assert.equal(d.out.route, 'risk');
  assert.match(d.out.reason, /(^|; )P0 sharp 0\.35\.4 in station — GHSA-wq5f-xc86-pv6w high, fixed in 0\.35\.5/);
  assert.ok(JSON.stringify(d.out).length < 16 * 1024);
});

test('the GitHub issue: one per advisory and repository, label P0, nothing about the company, mentions defused', async () => {
  const t = fixture();
  await SW.refresh(Object.assign({}, t.opts, { force: true }));
  assert.equal(t.gh.created.length, 1);
  const call = t.gh.calls.find(a => a[1] === 'create');
  assert.deepEqual([call[0], call[1], call[2], call[3]], ['issue', 'create', '-R', 'example/framework']);
  assert.ok(call.includes('P0') && call.includes('security'));
  const body = call[call.indexOf('--body') + 1], title = call[call.indexOf('--title') + 1];
  assert.match(title, /^P0 security: sharp below 0\.35\.5 — GHSA-wq5f-xc86-pv6w \(high\)$/);
  assert.match(body, /secwatch-[0-9a-f]{16}/);
  for (const bad of ['Fixture Co', 'Pat Owner', 'Riley', 'Alex', t.opts.root, os.hostname()]) assert.ok(!body.includes(bad) && !title.includes(bad), 'issue carries ' + bad);
  // advisory text is outside data: an @mention in it never pings anyone
  const f = Object.values(SW.readState(t.ctx).findings).find(x => x.name === 'sharp');
  assert.doesNotMatch(SW.issueBody(Object.assign({}, f, { summary: 'ping @someone now' }), 'example/framework', 'secwatch-x'), /@someone/);
});

test('dedupe across companies: a second company on the same framework finds the issue and files none', async () => {
  const a = fixture(), b = fixture();
  b.opts.gh = (args) => { b.gh.calls.push(args); if (args[1] === 'list') return a.opts.gh(args); if (args[1] === 'create') { b.gh.created.push(args.join(' ')); return { status: 0, stdout: 'https://github.com/example/framework/issues/99\n' }; } return { status: 0, stdout: '' }; };
  b.ctx = SW.ctxOf(b.opts);
  await SW.refresh(Object.assign({}, a.opts, { force: true }));
  await SW.refresh(Object.assign({}, b.opts, { force: true }));
  assert.equal(a.gh.created.length, 1); assert.equal(b.gh.created.length, 0);
  const rec = Object.values(SW.readState(b.ctx).issues)[0];
  assert.equal(rec.by, 'found'); assert.equal(rec.number, 1);
});

test('the gate refuses the issue: nothing is filed, the CEO is asked once for a standing row, the watch retries later', async () => {
  const t = fixture({ gate: () => ({ allow: false, reason: 'no clearance row' }) });
  await SW.refresh(Object.assign({}, t.opts, { force: true }));
  assert.equal(t.gh.created.length, 0);
  const ceo = fs.readFileSync(path.join(t.opts.root, 'company', 'work', 'handoffs', 'to-alex.md'), 'utf8');
  assert.match(ceo, /external-gate\.js clear --by "Alex" --category publish --target "github:example\/framework#issues" --acts issue_create --agent any/);
  assert.match(ceo, /\*\*Priority:\*\* P0/);
  await SW.refresh(Object.assign({}, t.opts, { force: true }));
  assert.equal((fs.readFileSync(path.join(t.opts.root, 'company', 'work', 'handoffs', 'to-alex.md'), 'utf8').match(/standing row for P0 security issues/g) || []).length, 1, 'asked once');
  const rec = Object.values(SW.readState(t.ctx).issues)[0];
  assert.match(rec.error, /^gate:/); assert.ok(rec.retryAt);
});

test('OSV unreachable: npm audit (recorded answer) finds the same P0; then fully offline the last results stand and the check goes overdue', async () => {
  const audit = fs.readFileSync(path.join(FX, 'npm-audit.json'), 'utf8');
  const t = fixture({ net: { json: async () => { throw new Error('getaddrinfo ENOTFOUND api.osv.dev'); } }, npmAudit: () => ({ status: 1, stdout: audit }) });
  const r = await SW.refresh(Object.assign({}, t.opts, { force: true }));
  assert.equal(r.via, 'npm-audit');
  const S = SW.readState(t.ctx);
  const f = Object.values(S.findings).find(x => x.name === 'sharp');
  assert.equal(f.level, 'P0'); assert.equal(f.advisory, 'GHSA-wq5f-xc86-pv6w'); assert.equal(f.fixed, '0.35.5');
  assert.ok((S.notes || []).some(n => /npm audit was used/.test(n)));
  // now nothing answers: the findings stay, the error is recorded
  t.opts.npmAudit = () => ({ status: 1, stdout: 'not json' });
  const later = Date.now() + 7 * 3600e3;
  const r2 = await SW.refresh(Object.assign({}, at(t, later), { force: true }));
  assert.ok(r2.error);
  const S2 = SW.readState(t.ctx);
  assert.ok(S2.findings[f.id] && S2.findings[f.id].state === 'open', 'an offline check never marks a hole fixed');
  const d = SW.duty(at(t, Date.now() + 13 * 3600e3));
  assert.ok(d.out.items.some(i => /^sec-stale-/.test(i.id)), JSON.stringify(d.out));
});

test('due: not every tick — rescan time, a changed lockfile, or the owner\'s Check now', async () => {
  const t = fixture();
  const r1 = await SW.refresh(t.opts); assert.equal(r1.ran, true, 'first time');
  const r2 = await SW.refresh(at(t, Date.now() + 5 * 60e3)); assert.equal(r2.ran, false, 'nothing changed, inside the rescan time');
  fs.writeFileSync(path.join(t.opts.root, 'starnet', 'node_modules', 'sharp', 'package.json'), JSON.stringify({ name: 'sharp', version: '0.35.5' }));
  const r3 = await SW.refresh(at(t, Date.now() + 10 * 60e3)); assert.equal(r3.ran, true, 'a part changed: checked at once');
  const r4 = await SW.refresh(at(t, Date.now() + 15 * 60e3)); assert.equal(r4.ran, false);
  fs.writeFileSync(path.join(t.ctx.P.dir, 'check-now.json'), JSON.stringify({ at: new Date().toISOString(), by: 'owner' }));
  const r5 = await SW.refresh(at(t, Date.now() + 16 * 60e3)); assert.equal(r5.ran, true, 'Check now');
  assert.equal(fs.existsSync(path.join(t.ctx.P.dir, 'check-now.json')), false, 'the request is spent');
});

test('mitigate and hold: a workaround clears a no-fix item, not a P0 with a fix; a P0 hold needs a workaround and at most 7 days; only risk, the CEO or the owner', async () => {
  const t = fixture();
  await SW.refresh(Object.assign({}, t.opts, { force: true }));
  const S = SW.readState(t.ctx);
  const sharp = Object.values(S.findings).find(x => x.name === 'sharp');
  const cli = (args) => SW.record(t.ctx, args[0], (() => { const a = { _: args.filter(x => !x.startsWith('--')) }; for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) a[args[i].slice(2)] = args[++i]; return a; })());
  assert.throws(() => cli(['mitigate', sharp.id, '--by', 'Mallory', '--how', 'x']), /risk/);
  assert.throws(() => cli(['hold', sharp.id, '--by', 'Riley', '--why', 'upstream', '--until', new Date(Date.now() + 3 * 864e5).toISOString()]), /workaround recorded first/);
  cli(['mitigate', sharp.id, '--by', 'Riley', '--how', 'blocked VipsForeignLoadSvg in both call sites']);
  assert.ok(SW.duty(t.opts).out.items.some(i => i.id === sharp.id), 'a P0 with a fix stays due after a workaround');
  assert.throws(() => cli(['hold', sharp.id, '--by', 'Riley', '--why', 'upstream', '--until', new Date(Date.now() + 10 * 864e5).toISOString()]), /at most 7 days/);
  cli(['hold', sharp.id, '--by', 'Riley', '--why', 'waiting for the framework issue', '--until', new Date(Date.now() + 3 * 864e5).toISOString()]);
  assert.ok(!SW.duty(t.opts).out.items.some(i => i.id === sharp.id), 'held');
  assert.ok(SW.duty(at(t, Date.now() + 4 * 864e5)).out.items.some(i => i.id === sharp.id), 'the hold expires by itself');
  cli(['reopen', sharp.id, '--by', 'Alex', '--why', 'try again']);
  assert.ok(SW.duty(t.opts).out.items.some(i => i.id === sharp.id));
});

test('the duty is read-only and opens no socket (run as the dispatcher runs it)', async () => {
  const t = fixture();
  await SW.refresh(Object.assign({}, t.opts, { force: true }));
  const hash = () => { const out = {}; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out[f] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } }; walk(t.opts.root); return out; };
  const before = hash();
  const guard = path.join(tmp('secwatch-guard-'), 'guard.js');
  fs.writeFileSync(guard, "const M = require('module'); const o = M._load; M._load = function (r) { if (/^(node:)?(http|https|net|tls|dgram|undici)$/.test(r)) process.stderr.write('NETWORK:' + r + '\\n'); return o.apply(this, arguments); }; globalThis.fetch = () => { process.stderr.write('NETWORK:fetch\\n'); return Promise.reject(new Error('no')); };");
  const r = spawnSync(process.execPath, ['-r', guard, path.join(REPO, 'company', 'tools', 'security-watch.js'), '--duty'], { cwd: t.opts.root, encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH, HOME: t.opts.root, CAPHEOS_ROOT: t.opts.root, CAPHEOS_READONLY: '1', CAPHEOS_NO_NETWORK: '1', TZ: 'UTC' } });
  assert.equal(r.status, 1, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.priority, 'P0'); assert.equal(out.evidence, 'company/work/security/security-watch.md');
  assert.doesNotMatch(r.stderr, /NETWORK:/);
  assert.deepEqual(hash(), before, 'the duty changed a file');
  // the runner keeps priority and evidence, and refuses an evidence path outside company/work
  const R = require(path.join(REPO, 'company', 'tools', 'lib', 'duty-runner.js'));
  const p = R.parseDue(JSON.stringify(out));
  assert.equal(p.priority, 'P0'); assert.equal(p.evidence, 'company/work/security/security-watch.md');
  assert.equal(R.parseDue(JSON.stringify(Object.assign({}, out, { priority: 'urgent!', evidence: '../secrets/x' }))).priority, null);
  assert.equal(R.parseDue(JSON.stringify(Object.assign({}, out, { evidence: 'company/work/../../secrets/x' }))).evidence, null);
});

test('the owner hears it in plain words through the real owner notice (strict): found once, fixed once', async () => {
  const t = fixture();
  delete t.opts.notice;
  for (const f of ['owner-notices.json']) { fs.mkdirSync(path.join(t.opts.root, 'company', 'defaults', 'work', 'ops'), { recursive: true }); fs.copyFileSync(path.join(REPO, 'company', 'defaults', 'work', 'ops', f), path.join(t.opts.root, 'company', 'defaults', 'work', 'ops', f)); }
  const prev = process.env.CAPHEOS_NOTICE_STRICT; process.env.CAPHEOS_NOTICE_STRICT = '1';
  try {
    await SW.refresh(Object.assign({}, t.opts, { force: true }));
    const rows = () => fs.readFileSync(path.join(t.opts.root, 'company', 'owner', 'digest.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.equal(rows().length, 1);
    // one of the two (Node) needs the machine's administrator: the line never says 'nothing is needed' beside that ask
    assert.match(rows()[0].text, /^Riley found 2 known security holes in parts we use \(.+\) and is fixing one now\. The other needs an update on this machine that only its administrator can install; a separate message asks you for it\.$/);
    assert.doesNotMatch(rows()[0].text, /Nothing is needed/);
    assert.match(rows()[0].technical, /sharp 0\.35\.4, GHSA-wq5f-xc86-pv6w/);
    fs.writeFileSync(path.join(t.opts.root, 'starnet', 'node_modules', 'sharp', 'package.json'), JSON.stringify({ name: 'sharp', version: '0.35.5' }));
    await SW.refresh(Object.assign({}, t.opts, { force: true }));
    await SW.refresh(Object.assign({}, t.opts, { force: true }));
    assert.equal(rows().filter(r => /is fixed/.test(r.text)).length, 1);
    assert.match(rows().find(r => /is fixed/.test(r.text)).text, /^The security hole Riley found in the program the crew works in is fixed\.$/);
  } finally { if (prev === undefined) delete process.env.CAPHEOS_NOTICE_STRICT; else process.env.CAPHEOS_NOTICE_STRICT = prev; }
});

test('the console view is plain first: no package names, ids or versions outside technical', async () => {
  const t = fixture();
  await SW.refresh(Object.assign({}, t.opts, { force: true }));
  const v = SW.view(t.opts);
  assert.match(v.headline, /^2 known security holes in parts we use are being handled by Riley\.$/);
  const plain = JSON.stringify([v.headline, v.explain, v.rows.map(r => [r.part, r.how, r.status])]);
  assert.doesNotMatch(plain, /GHSA|CVE-|sharp|npm|\d+\.\d+\.\d+|node_modules|company\//);
  const s = v.rows.find(r => r.technical.package === 'npm sharp');
  assert.equal(s.part, 'the program the crew works in'); assert.equal(s.level, 'P0'); assert.equal(s.technical.fixed, '0.35.5');
});

test('deps.js fast track: only the exact first fixed release of an open P0 here', async () => {
  const t = fixture();
  await SW.refresh(Object.assign({}, t.opts, { force: true }));
  assert.ok(SW.fastTrack('node', 'sharp', '0.35.5', t.opts));
  assert.equal(SW.fastTrack('node', 'sharp', '0.35.6', t.opts), null, 'a newer, unreviewed release still waits for the age guard');
  assert.equal(SW.fastTrack('python', 'sharp', '0.35.5', t.opts), null);
  assert.equal(SW.fastTrack('node', 'fast-uri', '3.1.9', t.opts), null, 'P2: no fast track');
  assert.match(fs.readFileSync(path.join(REPO, 'company', 'tools', 'deps.js'), 'utf8'), /p\.kind === 'age'\) \{ const ft = securityFix\(/);
});

/* ---------------- review round 1 (2026-11-19): partial checks, runtime ids, lockfile coverage, wakes, words ---------------- */
const withNet = (t, over) => { const base = t.opts.net; t.opts.net = { json: async (url, opt) => { const r = over(url, opt); if (r !== undefined) return r instanceof Error ? Promise.reject(r) : r; return base.json(url, opt); } }; };
const byName = (t, n) => Object.values(SW.readState(t.ctx).findings).find(x => x.name === n);
const later = h => Date.now() + h * 3600e3;

test('B1: a Node or Chrome feed that fails never marks its finding fixed, and nothing tells the owner so', async () => {
  const t = fixture({ runtimes: [{ name: 'node', label: 'Node 22.23.5', version: '22.23.5' }, { name: 'chrome', label: 'Chrome 157.0.8103.78', version: '157.0.8103.78' }] });
  await SW.refresh(Object.assign({}, t.opts, { force: true }));
  assert.equal(byName(t, 'node').state, 'open'); assert.equal(byName(t, 'chrome').state, 'open');
  const n0 = t.notices.length;
  withNet(t, url => /dist\/index\.json|versionhistory/.test(url) ? new Error('getaddrinfo ENOTFOUND') : undefined);
  const r = await SW.refresh(Object.assign({}, at(t, later(1)), { force: true }));
  assert.equal(byName(t, 'node').state, 'open', 'node feed down: still open'); assert.equal(byName(t, 'chrome').state, 'open');
  assert.ok(r.partial && r.partial.some(x => /node release feed/.test(x)), JSON.stringify(r.partial));
  assert.equal(t.notices.length, n0, 'no "fixed" line'); assert.equal(t.notices.filter(n => /is fixed/.test(n.text)).length, 0);
  const S = SW.readState(t.ctx); assert.ok(S.lastScanAt && S.lastOkAt !== S.lastScanAt, 'a partial check is not a success');
});

test('B1: OSV down and npm audit clean (or out of time) never clears an OSV finding; the check counts as failed', async () => {
  const t = fixture();
  await SW.refresh(Object.assign({}, t.opts, { force: true }));
  const okAt = SW.readState(t.ctx).lastOkAt;
  withNet(t, url => /querybatch|\/v1\/vulns\//.test(url) ? Object.assign(new Error('out of time for this tick'), { budget: true }) : undefined);
  t.opts.npmAudit = () => ({ status: 0, stdout: JSON.stringify({ auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } }) });
  const r = await SW.refresh(Object.assign({}, at(t, later(7)), { force: true }));
  assert.equal(byName(t, 'sharp').state, 'open'); assert.equal(byName(t, 'sharp').level, 'P0');
  assert.ok(r.partial && r.partial.includes('npm'), JSON.stringify(r));
  assert.equal(SW.readState(t.ctx).lastOkAt, okAt, 'lastOkAt does not move on a partial check');
  assert.equal(t.notices.filter(n => /is fixed/.test(n.text)).length, 0);
  // still partial 13 h later: the duty says the check is not succeeding (never silently green)
  assert.ok(SW.duty(at(t, later(13))).out.items.some(i => /^sec-stale-/.test(i.id)));
});

test('B1: an advisory record that cannot be read (no cache) keeps its finding open', async () => {
  const t = fixture();
  await SW.refresh(Object.assign({}, t.opts, { force: true }));
  fs.rmSync(t.ctx.P.osv, { recursive: true, force: true });
  withNet(t, (url) => /\/v1\/vulns\/GHSA-wq5f/.test(url) ? new Error('HTTP 503') : undefined);
  const r = await SW.refresh(Object.assign({}, at(t, later(1)), { force: true }));
  assert.equal(byName(t, 'sharp').state, 'open'); assert.ok(r.kept.length >= 1, JSON.stringify(r));
  assert.ok(r.partial.some(x => /advisory record/.test(x)));
});

test('B1: a hole that comes back after it was fixed is told to the owner again', async () => {
  const t = fixture();
  await SW.refresh(Object.assign({}, t.opts, { force: true }));
  const pj = path.join(t.opts.root, 'starnet', 'node_modules', 'sharp', 'package.json');
  fs.writeFileSync(pj, JSON.stringify({ name: 'sharp', version: '0.35.5' }));
  await SW.refresh(Object.assign({}, t.opts, { force: true }));
  assert.equal(byName(t, 'sharp').state, 'fixed');
  fs.writeFileSync(pj, JSON.stringify({ name: 'sharp', version: '0.35.4' }));   // rolled back
  const r = await SW.refresh(Object.assign({}, t.opts, { force: true }));
  assert.equal(byName(t, 'sharp').state, 'open'); assert.deepEqual(r.reopened, [byName(t, 'sharp').id]);
  assert.equal(t.notices.filter(n => /^Riley found/.test(n.text) && /the program the crew works in/.test(n.text)).length, 2, JSON.stringify(t.notices.map(n => n.text)));
});

test('B2: one finding per runtime: a new upstream release moves its target, never a false fixed + a new found + a new ask', async () => {
  const t = fixture({ runtimes: [{ name: 'chrome', label: 'Chrome 157.0.8103.78', version: '157.0.8103.78' }] });
  let stable = '157.0.8103.90';
  withNet(t, url => /versionhistory/.test(url) ? { versions: [{ version: stable }, { version: '156.0.1.1' }] } : undefined);
  await SW.refresh(Object.assign({}, t.opts, { force: true }));
  const c1 = byName(t, 'chrome'); assert.equal(c1.fixed, '157.0.8103.90'); assert.equal(c1.advisory, 'RUNTIME-CHROME');
  stable = '157.0.8103.120';
  await SW.refresh(Object.assign({}, t.opts, { force: true }));
  const all = Object.values(SW.readState(t.ctx).findings).filter(x => x.eco === 'runtime:chrome');
  assert.equal(all.length, 1, 'still one Chrome finding'); assert.equal(all[0].id, c1.id); assert.equal(all[0].fixed, '157.0.8103.120'); assert.equal(all[0].state, 'open');
  assert.equal(t.asks.length, 1, 'asked once'); assert.equal(t.notices.filter(n => /is fixed/.test(n.text)).length, 0);
  // the question passes the owner's plain-words check (2026-11-19 the live watch failed every tick: three sentences, no
  // "what you get", no "if you skip it")
  const OS = require(path.join(__dirname, '..', 'lib', 'owner-scope.js'));
  const sc = OS.plainScore(t.asks[0].message, { approval: false });
  assert.ok(sc.ok, 'plain: ' + JSON.stringify(sc.problems) + ' — ' + t.asks[0].message);
  t.opts.runtimes = [{ name: 'chrome', label: 'Chrome 157.0.8103.90', version: '157.0.8103.90' }];   // updated, but not to the target
  await SW.refresh(Object.assign({}, t.opts, { force: true }));
  assert.equal(byName(t, 'chrome').state, 'open', 'below the target: still open');
  t.opts.runtimes = [{ name: 'chrome', label: 'Chrome 157.0.8103.120', version: '157.0.8103.120' }];
  await SW.refresh(Object.assign({}, t.opts, { force: true }));
  assert.equal(byName(t, 'chrome').state, 'fixed');
  // Node: a later release that is not a security release does not move anything
  const n = fixture();
  await SW.refresh(Object.assign({}, n.opts, { force: true }));
  const nid = byName(n, 'node').id, nfix = byName(n, 'node').fixed;
  withNet(n, url => /dist\/index\.json/.test(url) ? JSON.parse(fs.readFileSync(path.join(FX, 'node-index.json'), 'utf8')).concat([{ version: 'v22.99.0', security: false }]) : undefined);
  await SW.refresh(Object.assign({}, n.opts, { force: true }));
  assert.equal(byName(n, 'node').id, nid); assert.equal(byName(n, 'node').fixed, nfix);
  assert.equal(Object.values(SW.readState(n.ctx).findings).filter(x => x.eco === 'runtime:node').length, 1);
});

test('B3 + should-fix 6/7: pnpm, go.sum and pubspec.lock are read; other lockfiles, loose pins and private packages are listed as not covered', () => {
  const t = fixture({ projectRemotes: { app: 'https://github.com/example/app.git' } });
  const R = path.join(t.opts.root, 'company', 'repos', 'app');
  const w = (rel, body) => { const f = path.join(R, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
  w('apps/brand-book/pnpm-lock.yaml', "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      next:\n        specifier: ^15\n        version: 15.1.0(react@19.0.0)\n\npackages:\n\n  '@alloc/quick-lru@5.2.0':\n    resolution: {integrity: sha512-x}\n\n  next@15.1.0:\n    resolution: {integrity: sha512-y}\n\n  '@acme/private@1.0.0':\n    resolution: {tarball: https://npm.acme.example/@acme/private/-/private-1.0.0.tgz}\n\nsnapshots:\n\n  next@15.1.0(react@19.0.0):\n    dependencies:\n      react: 19.0.0\n");
  w('old/pnpm-lock.yaml', "lockfileVersion: '6.0'\n\npackages:\n\n  /lodash@4.17.20:\n    resolution: {integrity: sha512-z}\n    dev: true\n\n  /@scope/pkg@2.0.0(react@18.0.0):\n    resolution: {integrity: sha512-w}\n    dev: false\n");
  w('apps/agents/go.sum', 'golang.org/x/net v0.17.0 h1:abc=\ngolang.org/x/net v0.17.0/go.mod h1:def=\ngolang.org/x/text v0.3.0/go.mod h1:ghi=\n');
  w('apps/chatdesk-employee/_packages/chatdesk_core/pubspec.lock', '# Generated by pub\npackages:\n  async:\n    dependency: transitive\n    description:\n      name: async\n      url: "https://pub.dev"\n    source: hosted\n    version: "2.11.0"\n  flutter:\n    dependency: "direct main"\n    description: flutter\n    source: sdk\n    version: "0.0.0"\n  mytool:\n    dependency: "direct dev"\n    description:\n      path: "../mytool"\n    source: path\n    version: "1.0.0"\n  lints:\n    dependency: "direct dev"\n    description:\n      name: lints\n      url: "https://pub.dev"\n    source: hosted\n    version: "3.0.0"\nsdks:\n  dart: ">=3.0.0"\n');
  w('apps/chatdesk-employee/ios/Podfile.lock', 'PODS:\n  - Flutter (1.0.0)\n');
  w('api/scripts/photo/requirements.txt', 'pillow==10.0.0\nrequests>=2.31\nnumpy\n');
  w('api/package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'api' }, 'node_modules/express': { version: '4.18.0', resolved: 'https://registry.npmjs.org/express/-/express-4.18.0.tgz' }, 'node_modules/@company/secret-sdk': { version: '1.2.3', resolved: 'https://npm.pkg.github.com/download/@company/secret-sdk/1.2.3/abc' } } }));
  const inv = SW.inventory(t.ctx);
  const got = (eco, file) => inv.components.filter(x => x.eco === eco && x.where.file.includes(file)).map(x => x.name + '@' + x.version + (x.dev ? ':dev' : '')).sort();
  assert.deepEqual(got('npm', 'brand-book/pnpm-lock'), ['@alloc/quick-lru@5.2.0', 'next@15.1.0']);
  assert.deepEqual(got('npm', 'old/pnpm-lock'), ['@scope/pkg@2.0.0', 'lodash@4.17.20:dev']);
  assert.deepEqual(got('Go', 'go.sum'), ['golang.org/x/net@0.17.0'], 'a /go.mod-only line is not built in');
  assert.deepEqual(got('Pub', 'pubspec.lock'), ['async@2.11.0', 'lints@3.0.0:dev'], 'depth 5, hosted only');
  assert.deepEqual(got('npm', 'api/package-lock'), ['express@4.18.0'], 'a private package never goes to the public database');
  assert.ok(!JSON.stringify(inv.components).includes('secret-sdk') && !JSON.stringify(inv.components).includes('@acme/private'));
  const um = inv.unmatched.map(u => u.label + ' :: ' + u.why).join('\n');
  assert.match(um, /Podfile\.lock :: this kind of lockfile is not read yet/);
  assert.match(um, /requirements\.txt :: 2 line\(s\) not pinned to one version \(requests>=2\.31, numpy\)/);
  assert.match(um, /api\/package-lock\.json :: 1 package\(s\) from a private source/);
  assert.match(um, /brand-book\/pnpm-lock\.yaml :: 1 package\(s\) from a private source/);
  assert.match(um, /pubspec\.lock :: 1 package\(s\) from a private source/);
  assert.deepEqual(SW.parseGoSum('bad line\n').length, 0);
});

test('should-fix 1: a new P0 asks for the security-watch duty to run now, and the duty runner runs it first, past its cadence', async () => {
  const t = fixture();
  const marker = path.join(t.opts.root, 'company', 'state', 'duty-run-now.json');
  const r = await SW.refresh(Object.assign({}, t.opts, { force: true }));
  assert.equal(r.runNow, true); assert.ok(JSON.parse(fs.readFileSync(marker, 'utf8')).ids['security-watch']);
  fs.unlinkSync(marker);
  const r2 = await SW.refresh(Object.assign({}, t.opts, { force: true }));
  assert.ok(!r2.runNow && !fs.existsSync(marker), 'no new P0: no early run');
  // the runner (its own process: co.ROOT is fixed at load): ran a minute ago, cadence 15 min, but asked to run now
  const root = t.opts.root;
  fs.mkdirSync(path.join(root, 'company', 'work', 'ops'), { recursive: true });
  const R = require(path.join(REPO, 'company', 'tools', 'lib', 'duty-runner.js'));
  const ids = R.registry().map(d => d.id);
  fs.writeFileSync(path.join(root, 'company', 'work', 'ops', 'duty-policy.json'), JSON.stringify({ tickCapMs: 20000, duties: Object.fromEntries(ids.filter(i => i !== 'security-watch').map(i => [i, { enabled: false }])) }));
  fs.writeFileSync(path.join(root, 'company', 'state', 'duties.json'), JSON.stringify({ duties: { 'security-watch': { lastRun: new Date(Date.now() - 60e3).toISOString(), lastResult: 'ok' } } }));
  const run = () => spawnSync(process.execPath, ['-e', "const R = require(process.argv[1]); R.tick({}).then(o => console.log(JSON.stringify({ ran: o.ran, runNow: o.runNow })))", path.join(REPO, 'company', 'tools', 'lib', 'duty-runner.js')], { cwd: root, encoding: 'utf8', timeout: 60000, env: { PATH: process.env.PATH, HOME: root, CAPHEOS_ROOT: root, TZ: 'UTC' } });
  let o = JSON.parse(run().stdout.trim().split('\n').pop());
  assert.deepEqual(o.ran, [], 'inside its cadence: not run');
  fs.writeFileSync(marker, JSON.stringify({ ids: { 'security-watch': { at: new Date().toISOString(), why: 'new P0' } } }));
  o = JSON.parse(run().stdout.trim().split('\n').pop());
  assert.deepEqual(o.ran, ['security-watch']); assert.deepEqual(o.runNow, ['security-watch']);
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')).ids, {}, 'spent');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'company', 'state', 'duties.json'), 'utf8')).duties['security-watch'].priority, 'P0');
});

test('should-fix 2: a host-only P0 the owner was asked about is the owner\'s, not the seat\'s; a P2 with no fix is never due', async () => {
  const t = fixture();
  await SW.refresh(Object.assign({}, t.opts, { force: true }));
  const node = byName(t, 'node'), sharp = byName(t, 'sharp');
  assert.equal(node.hostOnly, true); assert.equal(sharp.hostOnly, false);
  assert.equal(t.asks.length, 1);
  const d = SW.duty(t.opts);
  assert.ok(d.out.items.some(i => i.id === sharp.id)); assert.ok(!d.out.items.some(i => i.id === node.id), 'the seat is not woken for what only the administrator can do');
  const row = SW.view(t.opts).rows.find(r => r.id === node.id);
  assert.match(row.status, /^Waiting for this machine to be updated \(you were asked on /); assert.equal(row.tone, 'warning');
  // the long-open reminder for a host-only P0 repeats the ask, it never says the crew is on it
  await SW.refresh(Object.assign({}, at(t, later(80)), { force: true }));
  const late = t.notices.find(n => n.key === 'secwatch:late:' + node.id);
  assert.match(late.text, /still needs the security update you were asked about \d+ days ago\. Please update it/);
  // a P2 with no fixed release: listed, never due
  const S = SW.readState(t.ctx); const D = { [sharp.id]: { hold: { until: new Date(later(24)).toISOString() }, mitigation: { how: 'x' } } };
  const p2 = Object.assign({}, sharp, { id: 'sec-p2nofix0', level: 'P2', action: 'watch', name: 'x' });
  fs.writeFileSync(t.ctx.P.watch, JSON.stringify(Object.assign({}, S, { findings: { [p2.id]: p2 } })));
  assert.equal(SW.duty(t.opts).code, 0, JSON.stringify(SW.duty(t.opts)));
  fs.writeFileSync(t.ctx.P.watch, JSON.stringify(Object.assign({}, S, { findings: { [p2.id]: Object.assign({}, p2, { action: 'fix', fixed: '9.9.9' }) } })));
  assert.ok(SW.duty(t.opts).out.items.some(i => /^sec-p2-/.test(i.id)));
  void D;
});

test('should-fix 3: exploited in the wild is P0 whatever the label; a missing label is looked up on the CVE alias', async () => {
  const t = fixture();
  const inv = SW.inventory(t.ctx);
  const rec = { id: 'PYSEC-0000-1', aliases: ['CVE-2026-777'], summary: 'no label', severity: [{ type: 'CVSS_V4', score: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N' }], affected: [{ package: { ecosystem: 'npm', name: 'kokoro-js' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }] }] }] };
  assert.equal(SW.severityOf(rec), 'UNKNOWN');
  const hits = new Map(); for (const x of inv.components.filter(x => x.name === 'kokoro-js')) hits.set(x.eco + '|' + x.name + '|' + x.version, [{ id: rec.id }]);
  const kevOnly = SW.buildFindings(t.ctx, SW.policy(t.ctx), inv, { hits, recs: { [rec.id]: rec } }, [], new Set(['CVE-2026-777']));
  assert.equal(kevOnly.find(x => x.name === 'kokoro-js').level, 'P0');
  assert.equal(kevOnly.find(x => x.name === 'kokoro-js').action, 'mitigate');
  // the alias lookup, through osvMatch with a fake service
  const cve = { id: 'CVE-2026-777', modified: '2026-11-01T00:00:00Z', severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }] };
  const net = { json: async (url, opt) => { if (/querybatch$/.test(url)) return { results: opt.body.queries.map(q => q.package.name === 'kokoro-js' ? { vulns: [{ id: rec.id, modified: '2026-11-01T00:00:00Z' }] } : {}) }; if (/PYSEC-0000-1$/.test(url)) return Object.assign({ modified: '2026-11-01T00:00:00Z' }, rec); if (/CVE-2026-777$/.test(url)) return cve; throw new Error('404'); } };
  const m = await SW.osvMatch(t.ctx, SW.policy(t.ctx), net, inv.components);
  assert.equal(m.aliasSev[rec.id], 'CRITICAL'); assert.ok(m.ecos.has('npm')); assert.equal(m.uncertain.size, 0);
  const withAlias = SW.buildFindings(t.ctx, SW.policy(t.ctx), inv, m, [], new Set());
  assert.equal(withAlias.find(x => x.name === 'kokoro-js').severity, 'CRITICAL');
});

test('should-fix 4: a single host-only find tells the owner a separate message asks them, never "nothing is needed"', async () => {
  const t = fixture();
  withNet(t, url => /querybatch$/.test(url) ? undefined : undefined);
  fs.writeFileSync(path.join(t.opts.root, 'starnet', 'node_modules', 'sharp', 'package.json'), JSON.stringify({ name: 'sharp', version: '0.35.5' }));
  await SW.refresh(Object.assign({}, t.opts, { force: true }));
  const found = t.notices.filter(n => /found/.test(n.text));
  assert.equal(found.length, 1);
  assert.match(found[0].text, /^Riley found a known security hole in the engine the company's programs run on\. It needs an update on this machine that only its administrator can install; a separate message asks you for it\.$/);
  assert.equal(t.asks.length, 1);
});

test('should-fix 5: the search index lags; the plain P0-label listing still finds the other company\'s issue by token or exact title', async () => {
  const a = fixture(), b = fixture();
  await SW.refresh(Object.assign({}, a.opts, { force: true }));
  assert.equal(a.gh.created.length, 1);
  a.searchLag = true;   // the issue a just filed is not in the search index yet
  b.opts.gh = (args) => { b.gh.calls.push(args); if (args[1] === 'list') return a.opts.gh(args); if (args[1] === 'create') { b.gh.created.push(args.join(' ')); return { status: 0, stdout: 'https://github.com/example/framework/issues/99\n' }; } return { status: 0, stdout: '' }; };
  b.ctx = SW.ctxOf(b.opts);
  await SW.refresh(Object.assign({}, b.opts, { force: true }));
  assert.equal(b.gh.created.length, 0);
  assert.ok(b.gh.calls.some(c => c[1] === 'list' && c.includes('--label') && c.includes('P0') && !c.includes('--search')));
  // only the title matches (the body was edited by a maintainer): still the same issue
  a.issues[0].body = 'edited';
  const c = fixture(); c.opts.gh = (args) => { if (args[1] === 'list') return a.opts.gh(args); if (args[1] === 'create') { c.gh.created.push(1); return { status: 0, stdout: '' }; } return { status: 0, stdout: '' }; }; c.ctx = SW.ctxOf(c.opts);
  await SW.refresh(Object.assign({}, c.opts, { force: true }));
  assert.equal(c.gh.created.length, 0);
});

test('rollout switch: enabled false in the company policy holds the watch and its duty off; a hand dry run still checks and writes no findings', async () => {
  const t = fixture();
  fs.mkdirSync(t.ctx.P.work, { recursive: true }); fs.writeFileSync(t.ctx.P.policy, JSON.stringify({ enabled: false }));
  const r = await SW.refresh(t.opts); assert.equal(r.ran, false); assert.match(r.off, /enabled: false/);
  assert.equal(SW.duty(t.opts).code, 0);
  assert.equal(SW.view(t.opts).headline, 'The security check is switched off for now.');
  const d = await SW.refresh(Object.assign({}, t.opts, { force: true, dry: true, dryScan: true }));
  assert.equal(d.ran, true); assert.ok(d.findings.some(f => f.name === 'sharp' && f.level === 'P0'));
  assert.equal(fs.existsSync(t.ctx.P.watch), false, 'a dry run records nothing'); assert.equal(t.gh.created.length, 0); assert.equal(t.notices.length, 0); assert.equal(t.asks.length, 0);
  assert.equal(fs.existsSync(path.join(t.opts.root, 'company', 'state', 'duty-run-now.json')), false, 'and asks for no wake');
});
