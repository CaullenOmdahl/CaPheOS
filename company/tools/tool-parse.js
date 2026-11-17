#!/usr/bin/env node
/* tool-parse.js — does every tool in the layer even parse?
 *
 * Why: a tool caught mid-write by somebody fails `node --check` (an unterminated string literal, say). A gate wrapper
 * that treats any exit code other than its refusal code as a SOFT PASS then lets every push through ungated, while
 * nothing in the company says so: no checker parses a tool, only `harness-change.js apply` does, and only for the file
 * it is applying. The window is the defect this tool closes: a syntax error in a control is not a crash someone sees,
 * it is a control that silently answers "allowed".
 *
 * What it does: runs the real parse check (`node --check` for .js, `bash -n` for .sh) over the tools directory and
 * names each file that fails with the line the interpreter names. It reads nothing else: no selftest, no network,
 * no station. Cheap enough for a dispatch tick (a few seconds for the whole layer) and for the daily Tool health routine.
 *
 *   node company/tools/tool-parse.js                 # company/tools/*.js + *.sh   -> exit 0 clean, 1 findings
 *   node company/tools/tool-parse.js <dir|file>...    # other targets (dirs are scanned one level)
 *   node company/tools/tool-parse.js --verbose        # print an ok line per file too
 *   node company/tools/tool-parse.js --selftest       # fixture dir; exit 1 if it cannot see a broken file
 *   node company/tools/tool-parse.js --duty           # read-only duty check (docs/DUTIES.md) of the folder this tool is in:
 *                                                     # exit 0 all parse, 1 + JSON {due, reason, key, items} naming the files,
 *                                                     # 2 nothing to check (an empty set is never a pass)
 *
 * Exit: 0 everything parses, 1 at least one file does not (or a target is missing), 2 usage error.
 * Ownership: the tools owner. Runbook: company/work/engineering/tool-parse.md; wired into the daily Tool health
 * routine (step 1); negative control company/work/engineering/scripts/tool-parse-mutant.sh.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = require('./lib/company').ROOT;
const DEFAULT_DIR = path.join(ROOT, 'company', 'tools');

// Which interpreter checks this file: 'node', 'bash', or null (not a script — skipped). The extension decides when
// there is one; otherwise the shebang does, which is how ~/.local/bin/git and ~/.local/bin/gh get covered — they are
// the entry points the crew actually pushes through, and they have no extension.
function interpreterFor(file) {
  const ext = path.extname(file);
  if (ext === '.js') return 'node';
  if (ext === '.sh') return 'bash';
  if (ext) return null;
  let head = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(120);
    const n = fs.readSync(fd, buf, 0, 120, 0);
    fs.closeSync(fd);
    head = buf.slice(0, n).toString('utf8').split('\n')[0];
  } catch (_) { return null; }
  if (!head.startsWith('#!')) return null;
  if (/\bnode\b/.test(head)) return 'node';
  if (/(^#!.*\/)(ba|da|k|z)?sh\b/.test(head)) return 'bash';
  return null;
}

function listTargets(targets) {
  const files = [];
  const missing = [];
  for (const t of targets) {
    let st;
    try { st = fs.statSync(t); } catch (_) { missing.push(t); continue; }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(t).sort()) {
        const p = path.join(t, name);
        try { if (fs.statSync(p).isFile() && interpreterFor(p)) files.push(p); } catch (_) {}
      }
    } else {
      files.push(t);
    }
  }
  return { files, missing };
}

// One file, one real interpreter. Returns null when it parses, else { file, line, message }.
function parseOne(file) {
  const sh = interpreterFor(file) === 'bash';
  const r = cp.spawnSync(sh ? 'bash' : process.execPath, [sh ? '-n' : '--check', file], { encoding: 'utf8' });
  if (r.status === 0) return null;
  const err = (r.stderr || r.stdout || '').trim();
  // node prints "<file>:<line>\n<source line>\n<caret>\n\nSyntaxError: …"; bash prints "<file>: line N: …".
  let line = null;
  const nm = err.match(new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':(\\d+)'));
  const bm = err.match(/line (\d+):/);
  if (nm) line = Number(nm[1]); else if (bm) line = Number(bm[1]);
  const msg = (err.split('\n').find((l) => /^\s*(\w*Error|.*error:|.*unexpected)/i.test(l)) || err.split('\n')[0] || 'no output')
    .trim().slice(0, 160);
  return { file, line, message: msg };
}

function check(targets) {
  const { files, missing } = listTargets(targets);
  const findings = [];
  for (const f of files) {
    const bad = parseOne(f);
    if (bad) findings.push(bad);
  }
  return { files, missing, findings };
}

function report(targets, opts) {
  const { files, missing, findings } = check(targets);
  for (const m of missing) process.stderr.write(`tool-parse: no such target: ${m}\n`);
  for (const f of findings) {
    process.stdout.write(`FAIL  ${path.relative(ROOT, f.file) || f.file}${f.line ? ':' + f.line : ''} — ${f.message}\n`);
  }
  if (opts.verbose) {
    const bad = new Set(findings.map((f) => f.file));
    for (const f of files) if (!bad.has(f)) process.stdout.write(`ok    ${path.relative(ROOT, f) || f}\n`);
  }
  if (missing.length) {
    process.stdout.write(`TOOL-PARSE: FAIL (${missing.length} missing target${missing.length === 1 ? '' : 's'})\n`);
    return 1;
  }
  if (!files.length) {
    // A green over an empty set is the defect this tool exists to catch, one level up: a checker pointed at the wrong
    // directory must say so rather than report success.
    process.stdout.write('TOOL-PARSE: FAIL (no .js/.sh/sha-bang script found in the target — wrong directory?)\n');
    return 1;
  }
  if (findings.length) {
    process.stdout.write(`TOOL-PARSE: FAIL (${findings.length} of ${files.length} file(s) do not parse)\n`);
    return 1;
  }
  process.stdout.write(`TOOL-PARSE: OK (${files.length} file${files.length === 1 ? '' : 's'} parse)\n`);
  return 0;
}

// ── selftest: both directions, on a fixture dir of our own ──────────────────────────────────────────────────
function selftest() {
  const dir = path.join(ROOT, 'scratch', 'tool-parse-selftest-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const good = path.join(dir, 'good.js');
  const bad = path.join(dir, 'bad.js');
  const shell = path.join(dir, 'good.sh');
  fs.writeFileSync(good, "'use strict';\nconst x = 1;\nmodule.exports = x;\n");
  fs.writeFileSync(shell, '#!/bin/sh\nif true; then :; fi\n');
  let pass = 0;
  let fail = 0;
  const ok = (name, cond, extra) => {
    if (cond) { pass++; process.stdout.write(`ok    ${name}\n`); }
    else { fail++; process.stdout.write(`FAIL  ${name}${extra ? ' — ' + extra : ''}\n`); }
  };

  // 1. clean dir → no findings (a checker that only ever fails is not a check).
  let r = check([dir]);
  ok('a directory of valid .js/.sh has no findings', r.findings.length === 0 && r.files.length === 2,
    `files=${r.files.length} findings=${r.findings.length}`);

  // 2. one broken file → named, with its line. This is the case the tool exists for.
  fs.writeFileSync(bad, "'use strict';\nconst msg = 'unterminated;\nmodule.exports = msg;\n");
  r = check([dir]);
  ok('an unterminated string is found and named', r.findings.length === 1 && path.basename(r.findings[0].file) === 'bad.js',
    `findings=${JSON.stringify(r.findings.map((f) => path.basename(f.file)))}`);
  ok('the finding carries the interpreter line number', r.findings[0] && r.findings[0].line === 2,
    `line=${r.findings[0] && r.findings[0].line}`);

  // 3. remove it → clean again, so the finding was the file and not the directory.
  fs.rmSync(bad);
  r = check([dir]);
  ok('removing the broken file clears the finding', r.findings.length === 0);

  // 4. shell tools are parsed too (bash -n), on the same rule.
  fs.writeFileSync(shell, '#!/bin/sh\nif true; then\n');
  r = check([dir]);
  ok('an unclosed shell block is found', r.findings.length === 1 && path.basename(r.findings[0].file) === 'good.sh');
  fs.rmSync(shell);

  // 5. a missing target is a usage-class failure, not a silent pass.
  r = check([path.join(dir, 'not-here.js')]);
  ok('a missing target is reported, not ignored', r.missing.length === 1);

  // 6. exit codes, end to end: a broken tree exits 1, a clean tree exits 0, an empty tree exits 1 rather than
  //    reporting a green over nothing. Spawned rather than called, because the exit code is the contract.
  const cli = (p) => cp.spawnSync(process.execPath, [__filename, p], { encoding: 'utf8' }).status;
  const emptyDir = path.join(dir, 'empty');
  fs.mkdirSync(emptyDir, { recursive: true });
  ok('an empty target exits non-zero instead of reporting OK', cli(emptyDir) === 1, `exit=${cli(emptyDir)}`);
  const cleanDir = path.join(dir, 'clean');
  fs.mkdirSync(cleanDir, { recursive: true });
  fs.writeFileSync(path.join(cleanDir, 'a.js'), 'module.exports = 1;\n');
  ok('a clean tree exits 0 through the CLI', cli(cleanDir) === 0, `exit=${cli(cleanDir)}`);
  fs.writeFileSync(path.join(dir, 'broken.js'), "'use strict';\nconst msg = 'unterminated;\n");
  ok('a broken tree exits 1 through the CLI', cli(dir) === 1, `exit=${cli(dir)}`);

  // 7. duty: names the broken file, never the interpreter's text; an empty set is broken (2), never ok
  const d = dutyResult(check([dir]));
  ok('duty: a broken file is due with its name only', d.code === 1 && d.out.items.some((i) => i.id === 'broken.js') && !/unterminated|SyntaxError/.test(JSON.stringify(d.out)), JSON.stringify(d));
  ok('duty: a clean folder is not due', dutyResult(check([cleanDir])).code === 0);
  ok('duty: an empty folder is broken, never ok', dutyResult(check([emptyDir])).code === 2);

  fs.rmSync(dir, { recursive: true, force: true });
  process.stdout.write(`\nTOOL-PARSE SELFTEST: ${pass} passed, ${fail} failed\n`);
  return fail === 0 ? 0 : 1;
}

// duty (docs/DUTIES.md): the folder this file lives in (the company's tools layer), names only, never interpreter text
function dutyResult(res) {
  if (!res.files.length || res.missing.length) return { code: 2 };
  if (!res.findings.length) return { code: 0 };
  const names = res.findings.map((f) => path.basename(f.file)).sort();
  const key = 'tp-' + require('crypto').createHash('sha256').update(names.join(',')).digest('hex').slice(0, 10);
  return { code: 1, out: { due: true, reason: names.length + ' of ' + res.files.length + ' tool file(s) do not parse: ' + names.slice(0, 12).join(', ') + (names.length > 12 ? ', ...' : ''), key, items: names.map((n) => ({ id: n })) } };
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  if (argv.includes('--duty')) {
    const r = dutyResult(check([__dirname]));
    if (r.out) process.stdout.write(JSON.stringify(r.out) + '\n');
    return r.code;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('usage: node company/tools/tool-parse.js [--verbose|--selftest] [dir|file...]\n');
    return 0;
  }
  const opts = { verbose: argv.includes('--verbose') };
  const targets = argv.filter((a) => !a.startsWith('-'));
  return report(targets.length ? targets.map((t) => path.resolve(t)) : [DEFAULT_DIR], opts);
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { check, parseOne };
