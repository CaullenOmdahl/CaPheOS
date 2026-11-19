#!/usr/bin/env node
/**
 * text-corruption.js — find figures that a shell expanded before they reached the file.
 *
 * Asked for by the finance owner after money figures in the record came out mangled. The mechanism, exactly: a body written
 * through a shell double-quoted string has its `$…` expanded. `$0.4321` therefore lands as
 * `/bin/sh` (the shell's own name) followed by `.4321`, and `$3` / `$4` expand to *nothing*, so
 * those amounts lose their leading characters and read as if they were never money at all.
 *
 * WHAT THIS CATCHES: the class that leaves a signature — a shell name glued to a decimal,
 * `…/bin/sh.4321`. That is every case where the figure started with `$0`.
 *
 * WHAT IT CANNOT CATCH, said plainly: an amount that began `$1`–`$9` left no trace at all
 * (`$3.97` → `.97`, `$4` → ``), so no scan can find it. Those are found by an arithmetic
 * re-check of the record, which the finance owner does by hand. This tool is the
 * half that can be automated; do not read a PASS as "the file is arithmetically sound".
 *
 * Usage:
 *   node company/tools/text-corruption.js                 # scan company/, report, exit 1 on any hit
 *   node company/tools/text-corruption.js --scan <dir|file>
 *   node company/tools/text-corruption.js --quiet         # summary line only
 *   node company/tools/text-corruption.js --json
 *   node company/tools/text-corruption.js --selftest
 *
 * Wired into the same pass as the handoff lint: `handoff-status.js` runs this scan last, so the
 * Tool health check covers both with the command it already runs.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = require('./lib/company').ROOT;
const EXTS = new Set(['.md', '.jsonl', '.json', '.txt', '.log']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.starnet-data', 'scratch']);

// A shell name followed immediately by `.` and a digit. `$0.4321` is the only expansion that
// leaves this: /bin/sh (or sh/bash/zsh, which is how a one-liner's `$0` can read).
// The left guard keeps a legitimate path fragment such as `fizz.sh.1` out of the report.
const SIGNATURE = /(^|[^\w.\-])((?:\/bin\/)?(?:sh|bash|zsh|dash))\.(?=\d)/;

// A document that DESCRIBES this defect has to be able to quote it. The marker is explicit, per
// line, and counted in the output — so an allowance is a visible number, not a silent whitewash.
const EXAMPLE_MARKER = 'text-corruption:example';

function scanText(text) {
  const hits = [];
  hits.allowed = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(EXAMPLE_MARKER)) { if (SIGNATURE.test(lines[i])) hits.allowed++; continue; }
    const m = SIGNATURE.exec(lines[i]);
    if (!m) continue;
    const at = m.index + m[0].length;   // right after the shell name, where the eaten `.` begins
    const tail = /^(\d+)/.exec(lines[i].slice(at));   // m[0] already consumed the eaten `.`
    hits.push({
      line: i + 1,
      found: m[2] + (tail ? '.' + tail[1] : ''),
      // the repair is mechanical: `$0` was what the shell ate
      repair: '$0' + (tail ? '.' + tail[1] : ''),
      text: lines[i].trim().slice(0, 160),
    });
  }
  return hits;
}

function walk(target, out) {
  let st;
  try { st = fs.statSync(target); } catch (_) { return out; }
  if (st.isFile()) { if (EXTS.has(path.extname(target))) out.push(target); return out; }
  let names = [];
  try { names = fs.readdirSync(target); } catch (_) { return out; }
  for (const n of names) {
    if (SKIP_DIRS.has(n)) continue;
    const p = path.join(target, n);
    let s;
    try { s = fs.lstatSync(p); } catch (_) { continue; }
    if (s.isDirectory()) walk(p, out);
    else if (EXTS.has(path.extname(p))) out.push(p);
  }
  return out;
}

function scanPath(target) {
  const files = walk(target, []);
  const findings = [];
  let allowed = 0;
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    const hits = scanText(text);
    allowed += hits.allowed;
    for (const h of hits) findings.push(Object.assign({ file: path.relative(ROOT, f) || f }, h));
  }
  return { files: files.length, findings, allowed };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: text-corruption.js [--scan <dir|file>] [--quiet] [--json] | --selftest');
    process.exit(0);
  }
  if (argv.includes('--selftest')) process.exit(selftest());
  const i = argv.indexOf('--scan');
  const target = i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : path.join(ROOT, 'company');
  const quiet = argv.includes('--quiet');
  const r = scanPath(target);
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ target: path.relative(ROOT, target) || target, files: r.files, findings: r.findings, allowedExamples: r.allowed }, null, 1));
    process.exit(r.findings.length ? 1 : 0);
  }
  if (!quiet) for (const f of r.findings) console.log('CORRUPT  ' + f.file + ':' + f.line + '  ' + f.found + '  -> ' + f.repair);
  console.log((r.findings.length ? 'TEXT INTEGRITY: FAIL — ' : 'TEXT INTEGRITY: PASS — ') + r.findings.length
    + ' shell-expanded figure(s) in ' + r.files + ' file(s) under ' + (path.relative(ROOT, target) || target)
    + (r.findings.length ? ' (a figure a shell ate reads as prose and cannot be trusted)' : ''));
  if (r.allowed) console.log('  ' + r.allowed + ' line(s) quote the signature on purpose under the ' + EXAMPLE_MARKER + ' marker — allowed, and counted here so the allowance is never silent.');
  console.log('  limit: an amount that began $1-$9 left no trace and this scan cannot see it — re-check those by arithmetic, not by grep.');
  process.exit(r.findings.length ? 1 : 0);
}

/* ---- selftest: the cases are the ones this file exists for, plus the false positives it must not have ---- */
function selftest() {
  const cp = require('child_process');
  const dir = require('./lib/temp-life').tmpDir('text-corruption-');
  const write = (name, text) => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p; };
  const cases = [
    { name: 'a clean record passes', file: 'clean.md', body: 'spend was $0.4321 and $4.0990 today\n', want: 0, must: ['PASS — 0'] },
    { name: 'the signature is caught (the defect this tool exists for)', file: 'corrupt.md', body: 'difference /bin/sh.4321 or 7.1%\n', want: 1,
      must: ['FAIL — 1', 'corrupt.md:1', '/bin/sh.4321', '-> $0.4321'] },
    { name: 'sh.0324 in a JSONL row is caught too', file: 'log.jsonl', body: '{"spend":"MiniMax /bin/sh.0324"}\n', want: 1,
      must: ['FAIL — 1', 'log.jsonl:1'] },
    { name: 'a legit filename containing .sh. is not a finding', file: 'paths.md', body: 'see build.sh.1 and fizz.sh.2 in the log\n', want: 0,
      must: ['PASS — 0'] },
    { name: 'the correctly written figure is not a finding', file: 'ok.md', body: 'spend $0.4321 (a shell did not eat this one)\n', want: 0,
      must: ['PASS — 0'] },
    { name: 'two hits on one file are two lines, not one', file: 'two.md', body: 'a /bin/sh.0000\nb ok\nc bash.5\n', want: 1,
      must: ['FAIL — 2', 'two.md:1', 'two.md:3'] },
    { name: 'a line quoting the defect under the marker is allowed and counted', file: 'doc.md',
      body: 'it lands as /bin/sh.4321 where $0.4321 belongs  <!-- text-corruption:example -->\n', want: 0,
      must: ['PASS — 0', '1 line(s) quote the signature on purpose'] },
  ];
  let pass = 0;
  for (const c of cases) {
    write(c.file, c.body);
    let out = '', status = 0;
    try { out = cp.execFileSync(process.execPath, [__filename, '--scan', dir], { encoding: 'utf8' }); }
    catch (e) { out = String(e.stdout || ''); status = Number(e.status) || 1; }
    const missing = c.must.filter(m => !out.includes(m));
    // per-case isolation: the scanner reads the whole dir, so only grade a case's own file lines
    const own = out.split('\n').filter(l => l.includes(c.file + ':')).length;
    const okCase = status === c.want && missing.length === 0;
    if (okCase) pass++;
    console.log((okCase ? 'PASS' : 'FAIL') + '  ' + c.name + (okCase ? '' : '  (exit ' + status + ', wanted ' + c.want
      + ', own hits ' + own + (missing.length ? ', missing: ' + missing.join(' | ') : '') + ')'));
    try { fs.unlinkSync(path.join(dir, c.file)); } catch (_) {}
  }
  console.log('\nselftest: ' + pass + '/' + cases.length);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  return pass === cases.length ? 0 : 1;
}

if (require.main === module) main();
module.exports = { scanText, scanPath };
