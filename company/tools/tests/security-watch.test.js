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
const roots = [];
const tmp = p => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); roots.push(d); return d; };
test.after(() => { for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });
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
    assert.match(rows()[0].text, /^Riley found 2 known security holes in parts we use \(.+\) and is fixing them now\. Nothing is needed from you\.$/);
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
