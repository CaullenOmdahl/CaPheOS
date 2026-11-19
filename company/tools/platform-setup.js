#!/usr/bin/env node
/* platform-setup.js — set up the platform department, the crew's dev checkout of the framework and the CaPheOS role notes (docs/IMPROVE.md).
 *
 * The company that develops CaPheOS (Ca Phe Digital) gets a "platform" department whose lead receives the improvement
 * engine's items (lib/improve.js), a dev checkout of the framework repo OUTSIDE its live tree's git (dev/capheos,
 * excluded from the company checkout, with a pre-push hook that refuses main), and a "## CaPheOS" section in each
 * member's charter (text: company/runbooks/capheos-platform-role.md), and switches on the six improve-* duties in
 * company/work/ops/duty-policy.json (then locked-watch.js accept, as the owner).
 *
 *   node company/tools/platform-setup.js plan  [--company <root>] [--lead <seat>] [--members a,b,c]
 *                                               every step it would take, as commands; changes nothing
 *   node company/tools/platform-setup.js apply [--company <root>] [--lead <seat>] [--members a,b,c] [--repo <url>]
 *                                               [--skip department,dev,roles,duties]
 *                                               runs them (the department change through departments.js --by owner, so
 *                                               run it from the owner's shell); each step is skipped when already done
 * Defaults: lead engineer (the CEO may move it: departments.js set-lead platform <seat>), members deployer,
 * cand-eng-2026-11-bao, cand-qa-2026-11-vy (seats not on the crew are left out), repo = the framework's GitHub remote.
 * Owner: the tools function.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const IMPROVE_DUTIES = ['improve-health', 'improve-efficiency', 'improve-owner', 'improve-fr', 'improve-research', 'improve-retro'];
const DEF = { lead: 'engineer', members: ['deployer', 'cand-eng-2026-11-bao', 'cand-qa-2026-11-vy'], repo: 'https://github.com/CaullenOmdahl/CaPheOS.git' };
const HOOK = `#!/usr/bin/env bash
# platform-setup.js: the crew never pushes to the default branch; changes land by a reviewed pull request.
while read -r lref lsha rref rsha; do
  case "$rref" in refs/heads/main|refs/heads/master) echo "refused: no push to $rref (open a pull request)" >&2; exit 1;; esac
done
exit 0
`;

function args(argv) {
  const o = { cmd: argv[0], skip: [] };
  for (let i = 1; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--company') o.root = argv[++i]; else if (k === '--lead') o.lead = argv[++i]; else if (k === '--members') o.members = String(argv[++i] || '').split(',').filter(Boolean);
    else if (k === '--repo') o.repo = argv[++i]; else if (k === '--skip') o.skip = String(argv[++i] || '').split(',');
  }
  o.root = path.resolve(o.root || process.env.CAPHEOS_ROOT || path.join(__dirname, '..', '..'));
  o.lead = o.lead || DEF.lead; o.members = o.members || DEF.members; o.repo = o.repo || DEF.repo;
  return o;
}
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } };

function steps(o) {
  const crew = (readJson(path.join(o.root, 'company', 'tools', 'loops.json'), {}) || {}).agents || {};
  const depts = (readJson(path.join(o.root, 'company', 'departments.json'), {}) || {}).departments || [];
  const plat = depts.find(d => d && d.id === 'platform');
  const out = []; const why = 'the platform department develops CaPheOS (owner decision 2026-11-19: the crew merges and deploys its own framework changes)';
  const dj = ['company/tools/departments.js'];
  if (!crew[o.lead]) out.push({ kind: 'note', text: 'lead ' + o.lead + ' is not on the crew; pass --lead <seat>' });
  const members = o.members.filter(m => crew[m] && m !== o.lead);
  for (const m of o.members) if (!crew[m]) out.push({ kind: 'note', text: 'member ' + m + ' is not on the crew; left out' });
  if (!o.skip.includes('department') && crew[o.lead]) {
    if (!plat) out.push({ kind: 'run', argv: dj.concat(['create', 'platform', '--name', 'Platform (CaPheOS)', '--class', 'code', '--lead', o.lead, '--by', 'owner', '--why', why]) });
    for (const m of members) {
      const other = depts.find(d => d && d.id !== 'platform' && ([d.lead].concat(d.members || [])).includes(m));
      if (plat && ([plat.lead].concat(plat.members || [])).includes(m)) continue;
      out.push({ kind: 'run', argv: dj.concat(other ? ['move', m, 'platform'] : ['add-member', 'platform', m]).concat(['--by', 'owner', '--why', why]) });
    }
  }
  if (!o.skip.includes('dev')) {
    const dev = path.join(o.root, 'dev', 'capheos');
    if (!fs.existsSync(path.join(dev, '.git'))) out.push({ kind: 'clone', dir: dev, repo: o.repo });
    out.push({ kind: 'exclude', line: '/dev/' });
    out.push({ kind: 'hook', dir: dev });
  }
  if (!o.skip.includes('roles')) {
    const note = path.join(__dirname, '..', 'runbooks', 'capheos-platform-role.md');
    for (const s of [o.lead].concat(members)) {
      if (!crew[s]) continue;
      const rel = String(crew[s].role || '');
      const file = rel.includes('/') ? path.join(o.root, rel) : path.join(o.root, 'company', 'roles', rel);
      let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch (_) {}
      if (/^## CaPheOS\b/m.test(text)) continue;
      out.push({ kind: 'role', seat: s, file, note, lead: s === o.lead });
    }
  }
  if (!o.skip.includes('duties')) {
    const pol = readJson(path.join(o.root, 'company', 'work', 'ops', 'duty-policy.json'), null) || { duties: {} };
    const off = IMPROVE_DUTIES.filter(id => !(pol.duties && pol.duties[id] && pol.duties[id].enabled === true));
    if (off.length) out.push({ kind: 'policy', ids: off });
  }
  out.push({ kind: 'note', text: 'AI-time share: there is no per-department cap knob yet. Platform work should stay near a quarter of the Claude use; the improve-efficiency duty reports seats over their usual use (ROADMAP: platform share hold).' });
  return out;
}

function show(s) {
  if (s.kind === 'run') return 'node ' + s.argv.map(a => /[\s"'()]/.test(a) ? JSON.stringify(a) : a).join(' ');
  if (s.kind === 'clone') return 'git clone ' + s.repo + ' ' + s.dir;
  if (s.kind === 'exclude') return 'add ' + s.line + ' to .git/info/exclude of the company checkout';
  if (s.kind === 'hook') return 'install a pre-push hook in ' + s.dir + ' that refuses main/master';
  if (s.kind === 'policy') return 'switch on ' + s.ids.join(', ') + ' in company/work/ops/duty-policy.json, then node company/tools/locked-watch.js accept company/work/ops/duty-policy.json --by owner'
  if (s.kind === 'role') return 'append the "## CaPheOS" section to ' + s.file + (s.lead ? ' (as lead)' : '');
  return 'note: ' + s.text;
}

function roleSection(note, lead) {
  const t = fs.readFileSync(note, 'utf8');
  const body = t.split(/^<!-- section -->\s*$/m)[1] || t;
  return '\n' + body.trim().replace(/\{\{ROLE\}\}/g, lead ? 'You lead the platform department: you take the improvement items, split them, assign members, audit their work (ACCEPT or REVISE) and merge only through the gates.' : 'You are a member of the platform department: you take the items your lead assigns, check your own work first, and hand it to the lead for audit.') + '\n';
}

function apply(o, list) {
  let bad = 0;
  for (const s of list) {
    console.log('- ' + show(s));
    try {
      if (s.kind === 'run') { const r = spawnSync(process.execPath, s.argv, { cwd: o.root, stdio: 'inherit', env: Object.assign({}, process.env, { CAPHEOS_ROOT: o.root }) }); if (r.status !== 0) { bad++; console.log('  failed (exit ' + r.status + ')'); } }
      else if (s.kind === 'clone') { fs.mkdirSync(path.dirname(s.dir), { recursive: true }); const r = spawnSync('git', ['clone', '-q', s.repo, s.dir], { stdio: 'inherit' }); if (r.status !== 0) { bad++; console.log('  clone failed'); } }
      else if (s.kind === 'exclude') { const f = path.join(o.root, '.git', 'info', 'exclude'); if (fs.existsSync(path.join(o.root, '.git'))) { const t = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; if (!t.split('\n').includes(s.line)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, (t && !t.endsWith('\n') ? '\n' : '') + s.line + '\n'); } } }
      else if (s.kind === 'hook') { const h = path.join(s.dir, '.git', 'hooks', 'pre-push'); if (fs.existsSync(path.join(s.dir, '.git'))) { fs.mkdirSync(path.dirname(h), { recursive: true }); fs.writeFileSync(h, HOOK, { mode: 0o755 }); } else { bad++; console.log('  no dev checkout'); } }
      else if (s.kind === 'policy') {
        const f = path.join(o.root, 'company', 'work', 'ops', 'duty-policy.json');
        const pol = readJson(f, null) || readJson(path.join(o.root, 'company', 'defaults', 'work', 'ops', 'duty-policy.json'), null) || { version: 1, duties: {} };
        pol.duties = pol.duties || {}; for (const id of s.ids) pol.duties[id] = Object.assign({}, pol.duties[id], { enabled: true });
        fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(pol, null, 2) + '\n'); fs.renameSync(f + '.tmp', f);
        const r = spawnSync(process.execPath, ['company/tools/locked-watch.js', 'accept', 'company/work/ops/duty-policy.json', '--by', 'owner', '--why', 'switch on the improvement engine duties (docs/IMPROVE.md)'], { cwd: o.root, stdio: 'inherit', env: Object.assign({}, process.env, { CAPHEOS_ROOT: o.root }) });
        if (r.status !== 0) console.log('  locked-watch accept exit ' + r.status + ' (the edit is made; accept it by hand if it is flagged)');
      }
      else if (s.kind === 'role') { fs.mkdirSync(path.dirname(s.file), { recursive: true }); fs.appendFileSync(s.file, roleSection(s.note, s.lead)); }
    } catch (e) { bad++; console.log('  failed: ' + e.message); }
  }
  return bad ? 1 : 0;
}

if (require.main === module) {
  const o = args(process.argv.slice(2));
  if (o.cmd !== 'plan' && o.cmd !== 'apply') { console.error('usage: platform-setup.js plan|apply [--company <root>] [--lead <seat>] [--members a,b] [--repo <url>] [--skip department,dev,roles]'); process.exit(2); }
  const list = steps(o);
  if (o.cmd === 'plan') { for (const s of list) console.log('- ' + show(s)); process.exit(0); }
  process.exit(apply(o, list));
}
module.exports = { IMPROVE_DUTIES, steps, show, roleSection, apply, HOOK, DEF };
