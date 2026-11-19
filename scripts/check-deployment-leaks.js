#!/usr/bin/env node
'use strict';
/* check-deployment-leaks.js — no company's own content enters the framework (docs/PORTING.md rule 1).
 *
 * The words come from the companies on THIS machine, read fresh each run and never written into the repo: every crew
 * member's name (company/tools/loops.json), each company's name and owner (company/company.json), each company's folder
 * name, the home folder path, the git author email, the GitHub account of the framework remote, plus any extra words in
 * ~/.config/capheos/leak-words.txt (one per line). On a machine with no company (a fresh clone, CI) there is nothing
 * to compare against and the check passes.
 *
 *   node scripts/check-deployment-leaks.js                 the lines and commit messages this checkout adds over origin/main
 *   node scripts/check-deployment-leaks.js --base <ref>    ... over another base
 *   node scripts/check-deployment-leaks.js <file>...       whole files
 *   node scripts/check-deployment-leaks.js --words         print how many words were found and where from (not the words)
 *   CAPHEOS_COMPANIES_DIR=<dir>                            where the companies live (default ~/Companies)
 * Exit 0 clean, 1 a hit (each printed as file:line and the kind of word, never the matched word's source company list).
 */
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const readJ = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
const git = (...a) => spawnSync('/usr/bin/git', ['-C', REPO, ...a], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

// generic words that are seat titles or ordinary English, never a person to hide
const GENERIC = new Set(['founder', 'agent', 'owner', 'ceo', 'the', 'and', 'crew', 'company', 'station', 'console', 'lead', 'engineer',
  'deployer', 'recorder', 'commander', 'reviewer', 'tester', 'manager', 'head', 'chief', 'team', 'desk', 'room', 'seat', 'none', 'test',
  'claude', 'codex', 'opus', 'sonnet', 'haiku', 'fable', 'minimax', 'deepseek', 'capheos', 'starnet', 'digital', 'sandbox', 'studio', 'labs', 'co']);

function words(o) {
  o = o || {};
  const out = new Map();   // word -> kind
  const add = (w, kind) => { w = String(w || '').trim(); if (w.length < 2 || GENERIC.has(w.toLowerCase())) return; if (!out.has(w)) out.set(w, kind); };
  const dir = o.companiesDir || process.env.CAPHEOS_COMPANIES_DIR || path.join(os.homedir(), 'Companies');
  let companies = [];
  try { companies = fs.readdirSync(dir).map(d => path.join(dir, d)).filter(d => fs.existsSync(path.join(d, 'company', 'company.json'))); } catch (_) {}
  for (const root of companies) {
    if (path.resolve(root) === REPO) continue;
    const cj = readJ(path.join(root, 'company', 'company.json')) || {};
    if (cj.name) { add(cj.name, 'company name'); }
    add(path.basename(root), 'company folder');
    const owner = cj.owner && (cj.owner.name || cj.owner);
    if (typeof owner === 'string') for (const p of owner.split(/\s+/)) add(p, 'owner name');
    const agents = ((readJ(path.join(root, 'company', 'tools', 'loops.json')) || {}).agents) || {};
    for (const a of Object.values(agents)) {
      const name = String((a && a.name) || '').trim(); if (!name) continue;
      add(name, 'crew name');
      for (const p of name.split(/\s+/)) if (p.length >= 3) add(p, 'crew name');
    }
  }
  if (companies.length) {
    add(os.homedir(), 'home folder');
    const email = (git('config', 'user.email').stdout || '').trim(); if (email) add(email, 'git email');
    const m = String(git('remote', 'get-url', 'origin').stdout || '').match(/github\.com[:/]([^/\s]+)\//); if (m) add(m[1], 'GitHub account');
  }
  try { for (const l of fs.readFileSync(path.join(os.homedir(), '.config', 'capheos', 'leak-words.txt'), 'utf8').split('\n')) if (l.trim() && !l.startsWith('#')) add(l.trim(), 'extra word'); } catch (_) {}
  return { words: out, companies: companies.length };
}

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function matcher(ws) {
  const list = [...ws.keys()].sort((a, b) => b.length - a.length);
  if (!list.length) return null;
  // whole words only; a name is matched in its written case and all lower case (seat ids, file names)
  const alts = []; for (const w of list) { alts.push(esc(w)); if (w.toLowerCase() !== w) alts.push(esc(w.toLowerCase())); }
  return new RegExp('(?:(?<![A-Za-z0-9])|(?<=\\\\[nt]))(' + alts.join('|') + ')(?![A-Za-z0-9])');
}

function scanLines(items, re, ws) {
  const hits = [];
  for (const it of items) {
    const m = re.exec(it.text) || re.exec(it.file);
    if (m) hits.push({ file: it.file, line: it.line, kind: ws.get(m[1]) || ws.get([...ws.keys()].find(k => k.toLowerCase() === m[1].toLowerCase())) || 'word' });
  }
  return hits;
}

function addedLines(base) {
  const r = git('diff', '-U0', '--no-color', base + '...HEAD');
  const w = git('diff', '-U0', '--no-color', 'HEAD');           // and what is not committed yet
  const out = diffAdded([r.stdout || '', w.stdout || '']);
  // commit messages reach GitHub too: each new commit's message, as "commit <sha>" lines
  const msgs = git('log', '--format=%x00%h%n%B', base + '..HEAD').stdout || '';
  for (const block of msgs.split('\0').filter(Boolean)) {
    const [sha, ...body] = block.split('\n');
    body.forEach((t, i) => { if (t.trim()) out.push({ file: 'commit ' + sha + ' message', line: i + 1, text: t }); });
  }
  return out;
}
/* the added lines of unified diffs ({file, line, text}) */
function diffAdded(texts) {
  const out = [];
  for (const txt of texts) {
    let file = null, n = 0;
    for (const l of txt.split('\n')) {
      if (l.startsWith('+++ ')) { file = l.slice(4).replace(/^b\//, ''); continue; }
      const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)/); if (h) { n = Number(h[1]); continue; }
      if (file && file !== '/dev/null' && l.startsWith('+')) { out.push({ file, line: n, text: l.slice(1) }); n++; }
    }
  }
  return out;
}
/* for a tool holding a diff (capheos-merge.js on a pull request): the hits in its added lines, [] when clean or when no
   company is on this machine */
function scanDiff(text, o) {
  const W = words(o); const re = matcher(W.words); if (!re) return [];
  return scanLines(diffAdded([String(text || '')]), re, W.words);
}

function fileLines(files) {
  const out = [];
  for (const f of files) { let s = ''; try { s = fs.readFileSync(f, 'utf8'); } catch (_) { continue; } s.split('\n').forEach((t, i) => out.push({ file: f, line: i + 1, text: t })); }
  return out;
}

function main(argv) {
  const a = { files: [], base: 'origin/main' };
  for (let i = 0; i < argv.length; i++) { if (argv[i] === '--base') a.base = argv[++i]; else if (argv[i] === '--words') a.words = true; else a.files.push(argv[i]); }
  const W = words();
  if (a.words) { const kinds = {}; for (const k of W.words.values()) kinds[k] = (kinds[k] || 0) + 1; console.log(W.companies + ' compan' + (W.companies === 1 ? 'y' : 'ies') + ' on this machine; words by kind: ' + JSON.stringify(kinds)); return 0; }
  const re = matcher(W.words);
  if (!re) { console.log('deployment leaks: no company on this machine to compare against; nothing to check'); return 0; }
  const items = a.files.length ? fileLines(a.files) : addedLines(a.base);
  const hits = scanLines(items, re, W.words);
  if (!hits.length) { console.log('deployment leaks: clean (' + items.length + ' line(s) checked against ' + W.words.size + ' word(s) from ' + W.companies + ' compan' + (W.companies === 1 ? 'y' : 'ies') + ')'); return 0; }
  for (const h of hits.slice(0, 200)) console.log('LEAK  ' + h.file + ':' + h.line + '  a ' + h.kind + ' from a company on this machine');
  console.log('deployment leaks: ' + hits.length + ' line(s) carry a company\'s own words (docs/PORTING.md rule 1). Use a neutral example (Alex, Jo, Sam; "a data provider").');
  return 1;
}

module.exports = { words, matcher, scanLines, scanDiff, diffAdded };
if (require.main === module) process.exit(main(process.argv.slice(2)));
