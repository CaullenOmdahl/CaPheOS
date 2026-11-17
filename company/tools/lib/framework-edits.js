#!/usr/bin/env node
'use strict';
/* lib/framework-edits.js — a crew edit to a FRAMEWORK file in a running company becomes a framework request, and the file
 * goes back to the framework's version.
 *
 * In a founded company checkout, framework files (tracked, not one of the company-owned files) change only through a
 * framework update. An in-place edit — visible, or hidden by `git update-index --skip-worktree` — used to stay on disk:
 * the running company followed rules nobody shipped, and the next `git pull` aborted ("commit your changes or stash
 * them"), blocking every update. Now each such edit is:
 *   1. saved as the next fr-NNNN in company/work/framework-requests/ (the same request format as harness-change.js),
 *      with its exact diff against HEAD (a diff already filed is not filed again);
 *   2. restored to HEAD (and un-hidden), so the company follows the shipped rules and an update pulls clean;
 *   3. reported in one plain line.
 * Company-owned files (OWNED) are never touched. Callers: framework-update.js (before it pulls), scripts/instance-guard.sh
 * (instead of hiding such a file), locked-watch.js (every tick: an edit is caught within one tick, the editor and the
 * CEO are told).
 *
 *   node company/tools/lib/framework-edits.js list [--json]     what would be filed (changes nothing)
 *   node company/tools/lib/framework-edits.js sweep [--by <who>] [--json]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// the tracked files a company owns: its own settings, never a framework edit (framework-update.js merges them)
const OWNED = ['company/company.json', 'company/CHARTER.md', 'company/competence-policy.json', 'company/model-policy.json', 'company/tools/loops.json'];
const REQ_DIR = root => path.join(root, 'company', 'work', 'framework-requests');
const sha = b => 'sha256:' + crypto.createHash('sha256').update(b).digest('hex');

function git(root, args, opts) {
  const r = spawnSync('git', ['-C', root].concat(args), Object.assign({ encoding: 'utf8', timeout: 60000, maxBuffer: 64 << 20, env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }) }, opts || {}));
  return { ok: r.status === 0, status: r.status, out: r.stdout, err: String(r.stderr || '') };
}
// only a founded company's own checkout (never the framework's development checkout, never a copy inside another repo)
function applies(root) {
  if (!fs.existsSync(path.join(root, 'company', 'work', '.founded'))) return false;
  const top = git(root, ['rev-parse', '--show-toplevel']); if (!top.ok) return false;
  let real = root; try { real = fs.realpathSync(root); } catch (_) {}
  return String(top.out).trim() === real;
}
// the next framework-request id: fr-0007.md and hand-written fr-0007-some-title.md share one sequence
function nextRequestId(dir) {
  let n = 0; try { for (const f of fs.readdirSync(dir)) { const m = /^fr-(\d+)(?:[-.][^/]*)?\.md$/.exec(f); if (m) n = Math.max(n, Number(m[1])); } } catch (_) {}
  return 'fr-' + String(n + 1).padStart(4, '0');
}
// the framework files this company changed: hidden (skip-worktree) or visibly modified, whose bytes differ from HEAD
function crewEdits(root) {
  if (!applies(root)) return [];
  const hidden = String(git(root, ['ls-files', '-v']).out || '').split('\n').filter(l => /^S /.test(l)).map(l => l.slice(2));
  const visible = String(git(root, ['diff', '--name-only', 'HEAD']).out || '').split('\n').filter(Boolean);
  const out = [];
  for (const f of [...new Set(hidden.concat(visible))]) {
    if (!f || OWNED.includes(f)) continue;
    const head = spawnSync('git', ['-C', root, 'show', 'HEAD:' + f], { maxBuffer: 64 << 20 });
    if (head.status !== 0) continue;   // not in HEAD: not a framework file
    const p = path.join(root, f); const disk = fs.existsSync(p) ? fs.readFileSync(p) : null;
    if (disk && Buffer.compare(disk, head.stdout) === 0) continue;   // matches HEAD: nothing to file
    out.push({ file: f, hidden: hidden.includes(f), deleted: !disk, diff: diffOf(root, f, head.stdout, disk) });
  }
  return out;
}
function diffOf(root, f, headBuf, diskBuf) {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'fwedit-'));
  try {
    const a = path.join(T, 'a'), b = path.join(T, 'b'); fs.writeFileSync(a, headBuf); fs.writeFileSync(b, diskBuf || '');
    const r = spawnSync('git', ['diff', '--no-index', '--no-color', '--', a, b], { encoding: 'utf8', maxBuffer: 64 << 20 });
    const body = String(r.stdout || ''); const i = body.indexOf('\n@@');
    return '--- a/' + f + '\n+++ ' + (diskBuf ? 'b/' + f : '/dev/null') + '\n' + (i >= 0 ? body.slice(i + 1) : body);
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
}
// a request already holding this exact diff (the sweep runs every tick; one edit is one request)
function filedAlready(root, file, diffSha) {
  let names = []; try { names = fs.readdirSync(REQ_DIR(root)); } catch (_) { return null; }
  for (const n of names) { if (!/^fr-\d+.*\.md$/.test(n)) continue; let t = ''; try { t = fs.readFileSync(path.join(REQ_DIR(root), n), 'utf8').slice(0, 2000); } catch (_) { continue; } if (t.includes('- Diff: ' + diffSha) && t.includes('`' + file + '`')) return n.replace(/\.md$/, ''); }
  return null;
}
function fileRequest(root, e, o) {
  const diffSha = sha(e.diff);
  const already = filedAlready(root, e.file, diffSha); if (already) return { id: already, already: true };
  const dir = REQ_DIR(root); fs.mkdirSync(dir, { recursive: true });
  const id = nextRequestId(dir);
  const by = (o && o.by) || 'unknown (no tool recorded the edit)';
  const text = '# Framework change request ' + id + '\n\n- File: `' + e.file + '`\n- Proposed by: ' + by + ' (an in-place edit of a framework file in this company' + (e.hidden ? ', hidden from git with skip-worktree' : '') + ')\n'
    + '- Found by: ' + ((o && o.via) || 'framework-edits.js') + ', ' + new Date().toISOString() + '\n- Diff: ' + diffSha + '\n'
    + '- Why: not given; framework files change only through a framework update, so the edit was saved here and the file was put back to the framework\'s version\n\n'
    + 'This file belongs to the CaPheOS framework, so the change was not kept in this company. Forward it to the framework (it reaches this company with the next update).\n\n```diff\n' + e.diff.slice(0, 60000) + '\n```\n';
  fs.writeFileSync(path.join(dir, id + '.md'), text);
  return { id, already: false };
}
function restore(root, f) {
  git(root, ['update-index', '--no-skip-worktree', '--', f]);
  return git(root, ['checkout', 'HEAD', '--', f]).ok;
}
/* sweep(root, {by, via, dry}) -> { edits: [{file, fr, restored}], line } — file, restore, say */
function sweep(root, o) {
  o = o || {};
  const edits = crewEdits(root); const done = [];
  for (const e of edits) {
    if (o.dry) { done.push({ file: e.file, fr: null, restored: false }); continue; }
    const r = fileRequest(root, e, o);
    done.push({ file: e.file, fr: r.id, already: r.already, restored: restore(root, e.file) });
  }
  const line = done.length ? done.length + ' framework file(s) edited in this company saved as framework requests and put back: ' + done.map(d => d.file + ' -> ' + (d.fr || '(dry run)')).join(', ') : '';
  return { edits: done, line };
}

module.exports = { OWNED, applies, crewEdits, nextRequestId, fileRequest, restore, sweep };

if (require.main === module) {
  const a = process.argv.slice(2); const cmd = a[0]; const json = a.includes('--json');
  const by = a.includes('--by') ? a[a.indexOf('--by') + 1] : null;
  const root = path.resolve(process.env.CAPHEOS_ROOT || path.join(__dirname, '..', '..', '..'));
  if (cmd === 'list') { const l = crewEdits(root).map(e => ({ file: e.file, hidden: e.hidden })); console.log(json ? JSON.stringify(l) : (l.map(x => x.file).join('\n') || 'no framework file edited in this company')); process.exit(0); }
  if (cmd === 'sweep') { const r = sweep(root, { by, via: by ? 'framework-edits.js sweep (' + by + ')' : 'framework-edits.js sweep' }); console.log(json ? JSON.stringify(r) : (r.line || 'no framework file edited in this company')); process.exit(0); }
  console.error('usage: framework-edits.js list|sweep [--by <who>] [--json]'); process.exit(2);
}
