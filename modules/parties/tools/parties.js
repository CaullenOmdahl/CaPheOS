#!/usr/bin/env node
/* parties.js — the registry of outside parties (clients, customers, counterparties), each with its own data folder.
 *
 * A party is company/work/parties/<id>/party.json plus whatever its work puts beside it. Tools never build a party path
 * by hand: they call parties.path(id, ...parts), which refuses an unknown id, a malformed id and any part that would
 * leave the party's folder (.., absolute, backslash, NUL). Events and commitments carry a `party` field; a run that
 * works for one party is told the id in its handoff and logs it.
 *
 *   node company/tools/parties.js add <id> --name "<name>" [--kind client|customer|vendor|other] [--by <seat>] [--json]
 *   node company/tools/parties.js list [--json]
 *   node company/tools/parties.js show <id> [--json]
 *   node company/tools/parties.js path <id> [part...]      # prints the resolved path, exit 1 on refusal
 *   node company/tools/parties.js --selftest
 * Module: require('./parties.js') -> { path, get, list, exists, add, valid, ID_RE }.
 * Limits (kit.limits: company/state/modules/<id>/limits/ once the owner opens them; shipped closed): maxParties.
 * Exit: 0 ok, 1 refused / not found, 2 usage.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const LIB = [path.join(__dirname, 'lib'), path.join(__dirname, '..', '..', '..', 'company', 'tools', 'lib')].find(d => fs.existsSync(path.join(d, 'modkit.js')));
const co = require(path.join(LIB, 'company'));
const kit = require(path.join(LIB, 'modkit'));

const ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
const DIR = () => co.p('company', 'work', 'parties');
const LOG = () => co.p('company', 'work', 'parties', 'parties-log.jsonl');
const valid = id => typeof id === 'string' && ID_RE.test(id);

function base(id) {
  if (!valid(id)) throw new Error('party id "' + id + '" is not a valid id (' + ID_RE + ')');
  return path.join(DIR(), id);
}
function exists(id) { try { return fs.existsSync(path.join(base(id), 'party.json')); } catch (_) { return false; } }
function partyPath(id, ...parts) {
  const b = base(id);
  if (!exists(id)) throw new Error('no such party: ' + id);
  for (const p of parts) {
    const s = String(p);
    if (!s || s.includes('\0') || s.includes('\\') || path.isAbsolute(s) || s.split('/').some(x => x === '..' || x === '.')) throw new Error('refused: party path part "' + s + '" would leave the party folder');
  }
  const out = path.resolve(b, ...parts.map(String));
  if (out !== b && !out.startsWith(b + path.sep)) throw new Error('refused: resolves outside the party folder');
  // a symlink inside the folder must not lead out of it either
  let near = out; while (near !== b && !fs.existsSync(near)) near = path.dirname(near);
  const real = fs.realpathSync(near), rb = fs.realpathSync(b);
  if (real !== rb && !real.startsWith(rb + path.sep)) throw new Error('refused: a symlink leads outside the party folder');
  return out;
}
function get(id) { return valid(id) ? co.readJson(path.join(base(id), 'party.json'), null) : null; }
function list() {
  let ents = []; try { ents = fs.readdirSync(DIR(), { withFileTypes: true }); } catch (_) { return []; }
  return ents.filter(e => e.isDirectory() && valid(e.name)).map(e => get(e.name)).filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));
}
function add({ id, name, kind, by }) {
  if (!valid(id)) throw new Error('party id "' + id + '" is not a valid id (' + ID_RE + ')');
  if (exists(id)) return { ok: true, existed: true, party: get(id) };
  const max = kit.limit('parties', 'maxParties');
  if (list().length >= max) throw new Error('refused: the parties limit maxParties is ' + max + ' (limits ship closed; the owner opens them)');
  const party = { id, name: String(name || id), kind: kind || 'client', createdAt: new Date().toISOString(), createdBy: by || 'unknown' };
  kit.writeJson(path.join(base(id), 'party.json'), party);
  kit.appendJsonl(LOG(), { at: party.createdAt, act: 'add', id, by: party.createdBy });
  return { ok: true, party };
}

module.exports = { path: partyPath, get, list, exists, add, valid, ID_RE };

async function selftest(ok) {
  let threw = null;
  try { add({ id: 'acme', name: 'Acme' }); } catch (e) { threw = e.message; }
  ok('a closed limit refuses a new party', /maxParties is 0/.test(threw || ''), threw);
  kit.setLimits(co.ROOT, 'parties', { maxParties: 2 });
  ok('add a party once the limit is open', add({ id: 'acme', name: 'Acme', by: 'ceo1' }).party.name === 'Acme');
  ok('add is idempotent', add({ id: 'acme', name: 'Other' }).existed === true);
  ok('list has it', list().map(p => p.id).join() === 'acme');
  ok('path resolves inside the folder', partyPath('acme', 'reports', 'x.md') === path.join(DIR(), 'acme', 'reports', 'x.md'));
  for (const bad of [['..', 'beta'], ['../beta'], ['/etc/passwd'], ['a\\..\\b'], ['a/./b']]) {
    let r = null; try { partyPath('acme', ...bad); } catch (e) { r = e.message; }
    ok('traversal refused: ' + JSON.stringify(bad), /refused/.test(r || ''), r);
  }
  let r = null; try { partyPath('../acme'); } catch (e) { r = e.message; } ok('malformed id refused', /not a valid id/.test(r || ''));
  r = null; try { partyPath('nobody'); } catch (e) { r = e.message; } ok('unknown party refused', /no such party/.test(r || ''));
  fs.symlinkSync('/tmp', path.join(DIR(), 'acme', 'out'));
  r = null; try { partyPath('acme', 'out', 'x'); } catch (e) { r = e.message; } ok('symlink out of the folder refused', /symlink/.test(r || ''), r);
  add({ id: 'beta' });
  r = null; try { add({ id: 'gamma' }); } catch (e) { r = e.message; } ok('limit holds at maxParties', /maxParties is 2/.test(r || ''));
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest') || argv[0] === 'selftest') { kit.runSelftest(__filename, 'parties', selftest); return; }
  const a = kit.args(argv); const flag = k => a[k.slice(2)];
  const out = (o, text) => { console.log(a.json ? JSON.stringify(o, null, 2) : text); };
  const [cmd, id, ...rest] = a._;
  try {
    if (cmd === 'add') { const r = add({ id, name: flag('--name'), kind: flag('--kind'), by: flag('--by') }); out(r, (r.existed ? 'exists ' : 'added ') + id); }
    else if (cmd === 'list') { const l = list(); out(l, l.map(p => p.id + '  ' + p.name + '  (' + p.kind + ')').join('\n') || '(no parties)'); }
    else if (cmd === 'show') { const p = get(id); if (!p) { console.error('no such party: ' + id); process.exit(1); } out(p, JSON.stringify(p, null, 2)); }
    else if (cmd === 'path') { const p = partyPath(id, ...rest); out({ path: p }, p); }
    else { console.error('usage: parties.js add|list|show|path|--selftest (see header)'); process.exit(2); }
  } catch (e) { console.error(e.message); process.exit(1); }
}
