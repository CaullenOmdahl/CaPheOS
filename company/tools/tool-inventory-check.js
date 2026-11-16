#!/usr/bin/env node
/* tool-inventory-check.js — the runbook's tool table has to be true, not tidy.
 *
 * WHY THIS EXISTS: an agent can write a new tool over an existing, certified one with the same name, because
 * nothing tells it the name is taken and `fs_write` reports success either way. The inventory then has a row
 * describing a file whose behaviour has just changed. This check cannot catch that moment — the discipline that
 * does is "list the folder, then read the row" — but it catches the state afterwards: a table that names a
 * script, and a script whose `--selftest` is no longer there, are both claims the company acts on. A row that
 * says a tool proves itself is a promise; the tool has to be able to keep it.
 *
 * WHAT IT CHECKS:
 *   1. every `company/tools/<name>` named in the runbook EXISTS;
 *   2. every tool named in the §7b selftest table carries `--selftest` in its own source, because that
 *      row says it has one;
 *   3. a quoted pre-change copy (`*.before.sh`) is a reference, not a tool — exempt, and said so;
 *   4. every script under `company/tools/` is documented in this runbook's §6/§7b. A tool nobody
 *      documented is a tool nobody can operate, and a row would have warned the author the name was taken.
 *
 * Check 4 SHIPS CLOSED, and the honest way to do that on a codebase with existing debt is a declared
 * baseline rather than a quiet exemption list:
 *   - `company/state/tool-inventory-baseline.json` lists the tools that are undocumented TODAY. A tool on
 *     that list is owed a row, not forgiven one;
 *   - a script that is neither documented nor in the baseline → **FAIL** (`undocumented`), so a new tool
 *     cannot arrive undocumented;
 *   - a baseline entry that has since been documented, or whose file no longer exists → **FAIL**
 *     (`stale-baseline`). The baseline only shrinks. A suppression list that never shrinks stops being a
 *     measure of anything, and the failure to delete one line is cheaper than a number nobody believes.
 *
 *   node company/tools/tool-inventory-check.js                 report; exit 1 on any finding
 *   node company/tools/tool-inventory-check.js --list-unlisted informational: selftest tools with no row
 *   node company/tools/tool-inventory-check.js --selftest      fixture runbook + fixtures tools; nothing live
 *
 * Owner: the tools seat (loops.json function `tools`). Runbook: company/runbooks/tool-management.md §7b.
 */
'use strict';
const fs = require('fs'), path = require('path');

const co = require('./lib/company');
const ROOT = co.ROOT;
const RUNBOOK = process.env.INVENTORY_RUNBOOK || co.p('company', 'runbooks', 'tool-management.md');
const TOOLS = process.env.INVENTORY_TOOLS || co.p('company', 'tools');
const BASELINE = process.env.INVENTORY_BASELINE || co.p('company', 'state', 'tool-inventory-baseline.json');
const EXEMPT = /\.before\.(sh|js)$/;   // a pre-change copy named in a mutant comparison, never a tool
const SCRIPT = /\.(js|sh|py|mjs)$/;    // an executable tool; a unit file, a folder or a doc is not one
const TOOL_RE = /company\/tools\/([A-Za-z0-9_.-]+)/g;

function readBaseline(p) {
  try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); return Array.isArray(j.baseline) ? j.baseline : []; }
  catch (_) { return null; }   // null = the file is missing or unreadable, which is not "no debt"
}

function scan(opts) {
  const runbookPath = opts.runbook, toolsDir = opts.tools;
  const text = fs.readFileSync(runbookPath, 'utf8');
  const named = new Set();
  let m;
  while ((m = TOOL_RE.exec(text))) named.add(m[1]);
  TOOL_RE.lastIndex = 0;

  const findings = [], notes = [];
  for (const name of [...named].sort()) {
    if (EXEMPT.test(name)) { notes.push('exempt (a pre-change copy, not a tool): ' + name); continue; }
    const p = path.join(toolsDir, name);
    if (!fs.existsSync(p)) { findings.push({ kind: 'missing', name, why: 'the runbook names it and it is not on disk' }); continue; }
    // Only the ones the §7b table lists are claiming a selftest; a tool mentioned in prose is not.
    const inTable = new RegExp('^\\|[^\\n]*`company/tools/' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '`', 'm').test(text);
    if (!inTable) continue;
    let src = '';
    try { src = fs.readFileSync(p, 'utf8'); } catch (_) { findings.push({ kind: 'unreadable', name, why: 'cannot read the file the table describes' }); continue; }
    if (src.indexOf('--selftest') < 0) findings.push({ kind: 'no-selftest', name, why: 'the §7b table says it has a --selftest and its source has no such flag' });
  }

  // Every script on disk has to be documented somewhere in this runbook (check 4). The debt that
  // already exists is written down in the baseline, in the open, and the baseline only shrinks.
  // `undefined` means "read the file"; `null` means "the file could not be read" and must stay distinguishable
  // from "there is no debt", because an unanswerable check is not a pass.
  const baseline = opts.baseline === undefined ? readBaseline(BASELINE) : opts.baseline;
  if (baseline === null) {
    findings.push({ kind: 'no-baseline', name: path.basename(BASELINE), why: 'the baseline file is missing or unreadable, so "every tool is documented" cannot be answered — and an unanswerable check is not a pass' });
  }
  const owed = new Set(baseline || []);
  const onDisk = [];
  for (const f of fs.readdirSync(toolsDir)) {
    const p = path.join(toolsDir, f);
    let st; try { st = fs.statSync(p); } catch (_) { continue; }
    if (!st.isFile() || EXEMPT.test(f) || !SCRIPT.test(f)) continue;
    onDisk.push(f);
    if (named.has(f)) continue;
    if (baseline === null) continue;            // already reported once; do not multiply it per file
    if (!owed.has(f)) findings.push({ kind: 'undocumented', name: f, why: 'no row in this runbook and not in the baseline — document it, or add it to company/state/tool-inventory-baseline.json on purpose' });
  }
  for (const b of [...(baseline || [])].sort()) {
    if (!onDisk.includes(b)) { findings.push({ kind: 'stale-baseline', name: b, why: 'the baseline names it and it is not a script on disk — delete the line' }); continue; }
    if (named.has(b)) findings.push({ kind: 'stale-baseline', name: b, why: 'now documented in the runbook — delete the line: the baseline only shrinks, and a stale entry makes the debt number wrong' });
  }
  // Informational: selftest-bearing tools with no row anywhere in the runbook.
  const unlisted = [];
  for (const f of onDisk) {
    let src = ''; try { src = fs.readFileSync(path.join(toolsDir, f), 'utf8'); } catch (_) { continue; }
    if (src.indexOf('--selftest') < 0) continue;
    if (!named.has(f)) unlisted.push(f);
  }
  return { named: [...named].sort(), findings, notes, unlisted, debt: (baseline || []).length, scripts: onDisk.length };
}

function report(r) {
  console.log('TOOL INVENTORY — ' + path.relative(ROOT, RUNBOOK));
  console.log('  tools named in the runbook: ' + r.named.filter(n => !EXEMPT.test(n)).length
    + ' · scripts on disk: ' + r.scripts
    + ' · documentation debt (baseline): ' + r.debt
    + ' · selftest tools with no row: ' + r.unlisted.length);
  for (const n of r.notes) console.log('  note  ' + n);
  for (const f of r.findings) console.log('  FAIL  ' + f.name + ' — ' + f.why);
  if (!r.findings.length) console.log('  PASS  every tool the runbook names exists, every tool in the §7b table still has its --selftest, and no script is undocumented outside the baseline');
  return r.findings.length ? 1 : 0;
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'inv-'));
  let fails = 0;
  // The assertion is the KIND of finding, not how many there are. The first version counted findings and its
  // negative control proved why that is not a check: with the missing-file branch deleted the file still
  // produced one finding ("unreadable", via a thrown read) and the mutant passed 5/5. A count cannot tell a
  // right failure from a wrong one.
  // Each case gets its own tools directory: check 4 reports every undocumented script on disk, so a fixture
  // shared between cases would leak into the next one's findings.
  const case_ = (label, runbookText, wantKinds, baseline, files) => {
    const tools = fs.mkdtempSync(path.join(tmp, 'tools-'));
    const rb = path.join(tools + '-runbook.md');
    for (const [name, body] of Object.entries(files || { good: '#!/bin/bash\n# --selftest\n', owed: '#!/bin/bash\n# --selftest\n', 'noself.sh': '#!/bin/bash\necho hi\n' })) fs.writeFileSync(path.join(tools, name), body);
    fs.writeFileSync(rb, runbookText);
    const r = scan({ runbook: rb, tools, baseline: baseline === undefined ? [] : baseline });
    const got = r.findings.map(f => f.kind).join(',');
    if (got === wantKinds) console.log('  ok   ' + label + (got ? ' [' + got + ']' : ' [clean]'));
    else { console.log('  FAIL ' + label + ' (want "' + wantKinds + '", got "' + got + '")'); fails++; }
  };
  const ONLY_GOOD = { 'good.sh': '#!/bin/bash\n# --selftest\n' };
  case_('a table row whose tool exists and carries --selftest', '| `company/tools/good.sh` | does a thing | `--selftest` → 1 | x |\n', '', [], ONLY_GOOD);
  case_('a table row whose tool is missing from disk', '| `company/tools/gone.sh` | does a thing | `--selftest` → 1 | x |\n', 'missing', [], {});
  case_('a table row whose tool has no --selftest', '| `company/tools/noself.sh` | does a thing | `--selftest` → 1 | x |\n', 'no-selftest', [], { 'noself.sh': '#!/bin/bash\necho hi\n' });
  case_('a prose mention with no table row claims no selftest', 'Run `company/tools/noself.sh` by hand.\n', '', [], { 'noself.sh': '#!/bin/bash\necho hi\n' });
  case_('a pre-change copy is exempt', 'Run `company/tools/good.sh` by hand.\n', '', [], { 'good.sh': '#!/bin/bash\n# --selftest\n', 'good.before.sh': '#!/bin/bash\n# --selftest\n' });
  // Check 4's cases. Each is a state the check has to tell apart: a new
  // undocumented tool (the overwrite case), declared debt that is still owed, and a baseline line that has gone stale.
  case_('an undocumented script not in the baseline BLOCKS', 'Run `company/tools/good.sh` by hand.\n', 'undocumented', [], { 'good.sh': '#!/bin/bash\n# --selftest\n', 'new.sh': '#!/bin/bash\n# --selftest\n' });
  case_('an undocumented script that the baseline declares as owed is not a finding', 'Run `company/tools/good.sh` by hand.\n', '', ['owed.sh'], { 'good.sh': '#!/bin/bash\n# --selftest\n', 'owed.sh': '#!/bin/bash\n# --selftest\n' });
  case_('a baseline line whose tool is now documented BLOCKS until the line is deleted', 'Run `company/tools/owed.sh` by hand.\n', 'stale-baseline', ['owed.sh'], { 'owed.sh': '#!/bin/bash\n# --selftest\n' });
  case_('a baseline line naming a file that is gone BLOCKS', 'Run `company/tools/good.sh` by hand.\n', 'stale-baseline', ['deleted-long-ago.sh'], ONLY_GOOD);
  case_('a missing baseline is UNKNOWN, not "no debt"', 'Run `company/tools/good.sh` by hand.\n', 'no-baseline', null, ONLY_GOOD);
  case_('a folder or a unit file is not a script', 'Run `company/tools/good.sh` by hand.\n', '', [], { 'good.sh': '#!/bin/bash\n# --selftest\n', 'x.service': '[Unit]\n', 'x.timer': '[Timer]\n' });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails ? '\nSELFTEST FAILED (' + fails + ')' : '\nSELFTEST PASSED');
  return fails ? 1 : 0;
}

const argv = process.argv.slice(2);
if (argv.includes('--selftest')) { process.exit(selftest()); }
const r = scan({ runbook: RUNBOOK, tools: TOOLS });
const rc = report(r);
if (argv.includes('--list-unlisted') && r.unlisted.length) {
  console.log('\nselftest tools with no row in this runbook (informational — some are documented in their own runbook):');
  for (const u of r.unlisted) console.log('  ' + u);
}
process.exit(rc);
