#!/usr/bin/env node
/* meeting-register.js — a meeting's action register (company/tools/lib/meeting-register.js), for each owner to update
 * their own lines in their own loop. Nothing here writes a line on someone else's behalf.
 *
 *   node company/tools/meeting-register.js list [--json]                       the meetings with a register
 *   node company/tools/meeting-register.js show <meeting-id> [--json]           every row, and the rows that fail validation
 *   node company/tools/meeting-register.js update <meeting-id> <actions|questions|kills> <n> --by <your name>
 *        [--status "done 2026-11-20: …"] [--plain "one sentence anyone can read"] [--date ..] [--affects ..]
 *        only the row's owner (rulings and "not recorded": the owner, from the console or the owner's own shell)
 *   node company/tools/meeting-register.js selftest
 * Exit: 0 ok, 1 selftest failure, 2 usage or refused. Owner of this tool: the tools function.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const co = require('./lib/company');
const REG = require('./lib/meeting-register');

function seatOf(name) {
  const c = co.crew(); const n = String(name || '').trim().toLowerCase();
  return Object.keys(c).find(id => id.toLowerCase() === n || String(c[id].name || '').toLowerCase() === n || String(c[id].name || '').toLowerCase().split(/\s+/)[0] === n) || null;
}
const names = id => id === 'owner' ? ((co.config.owner && co.config.owner.name) || 'the owner') : co.nameOf(id);
function list() {
  let files = []; try { files = fs.readdirSync(path.dirname(REG.file('x'))).filter(f => /^m-[a-z0-9]+\.json$/.test(f)); } catch (_) {}
  return files.map(f => { const r = REG.load(f.slice(0, -5)); return { id: r.id, date: r.date, title: r.title, rows: REG.SECTIONS.reduce((n, s) => n + r[s].length, 0), failing: REG.problems(r).length }; }).sort((a, b) => b.date.localeCompare(a.date));
}
function args(argv) { const o = { _: [] }; for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const k = a.slice(2); o[k] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true; } else o._.push(a); } return o; }
function main(argv) {
  const o = args(argv); const cmd = o._[0];
  const out = (x, text) => { console.log(o.json ? JSON.stringify(x, null, 1) : text); return 0; };
  if (cmd === 'list') { const l = list(); return out(l, l.map(r => r.id + '  ' + r.date + '  ' + r.rows + ' rows' + (r.failing ? ', ' + r.failing + ' failing validation' : '') + (r.title ? '  ' + r.title : '')).join('\n') || 'no registers yet'); }
  if (cmd === 'show') {
    const id = o._[1]; if (!/^m-[a-z0-9]{4,20}$/.test(String(id || ''))) { console.error('meeting-register.js: show <meeting-id>'); return 2; }
    const r = REG.load(id); return out(Object.assign({}, r, { problems: REG.problems(r) }), REG.render(r, names));
  }
  if (cmd === 'update') {
    const [, id, section, n] = o._;
    if (!/^m-[a-z0-9]{4,20}$/.test(String(id || '')) || !REG.SECTIONS.includes(section) || !(Number(n) > 0)) { console.error('meeting-register.js: update <meeting-id> <actions|questions|kills> <n> --by <name> [--status ..] [--plain ..]'); return 2; }
    if (!o.by || o.by === true) { console.error('meeting-register.js: --by <your name> is required'); return 2; }
    const own = require('./lib/owner');
    const isOwner = own.isOwnerName(o.by);
    if (isOwner) { const why = own.refusal(o.by, 'updating the meeting register'); if (why) { console.error('meeting-register.js: ' + why); return 2; } }
    const by = isOwner ? 'owner' : seatOf(o.by);
    if (!by) { console.error('meeting-register.js: "' + o.by + '" is not on the crew'); return 2; }
    const reg = REG.load(id);
    try { const row = REG.update(reg, section, n, { status: o.status === true ? null : o.status, plain: o.plain === true ? null : o.plain, date: o.date === true ? null : o.date, affects: o.affects === true ? null : o.affects }, by, isOwner); REG.save(reg, names); return out(row, 'updated ' + section + ' ' + n + ': ' + row.status); }
    catch (e) { console.error('meeting-register.js: ' + e.message); return 2; }
  }
  if (cmd === 'selftest' || argv.includes('--selftest')) return selftest();
  console.error('usage: meeting-register.js list | show <id> | update <id> <section> <n> --by <name> [...] | selftest'); return 2;
}
function selftest() {
  const os = require('os'); const { spawnSync } = require('child_process');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-register-selftest-'));
  let fails = 0; const ok = (name, c, x) => { if (!c) fails++; console.log((c ? 'ok   ' : 'FAIL ') + name + (c || x === undefined ? '' : ' :: ' + JSON.stringify(x).slice(0, 300))); };
  try {
    const W = (rel, v) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); };
    W('company/company.json', { name: 'Reg Test', owner: { name: 'Pat' }, timezone: 'UTC', station: { port: 1 } });
    W('company/tools/loops.json', { agents: { dave: { name: 'Dave', functions: ['ceo'], manager: null }, sam: { name: 'Sam', manager: 'dave' } } });
    fs.writeFileSync(path.join(T, '.capheos-selftest-fixture'), '');
    const run = (...a) => spawnSync(process.execPath, [__filename, ...a], { encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: T }) });
    const code = `const R=require(${JSON.stringify(path.join(__dirname, 'lib', 'meeting-register.js'))});const r=R.load('m-abcd1');
      R.add(r,'actions',{text:'Price the email options',plain:'Sharon finds what each email option costs',owner:'sam',date:'2026-11-20',affects:'Finance, Risk'},'sam');
      let bad=null;try{R.add(r,'actions',{text:'No plain line',owner:'sam',date:'own loop'},'sam')}catch(e){bad=e.code}
      R.add(r,'rulings',{text:'DeepSeek stays off',plain:'We do not use DeepSeek for now',proposedBy:'dave'},'dave');
      R.save(r);process.stdout.write(JSON.stringify({bad}));`;
    const r0 = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: T }) });
    ok('a row without a plain-language line fails validation', JSON.parse(r0.stdout || '{}').bad === 'invalid', r0.stderr);
    const md = fs.readFileSync(fs.readdirSync(path.join(T, 'company/work/meetings')).map(f => path.join(T, 'company/work/meetings', f))[0], 'utf8');
    ok('the register renders in the table register shape', /## Owner rulings/.test(md) && /\| 1 \| Price the email options \| Sharon finds what each email option costs \| Sam \| 2026-11-20 \| open \| Finance, Risk \|/.test(md) && /## Not recorded here/.test(md) && /not yet confirmed by the owner/.test(md), md);
    let r = run('update', 'm-abcd1', 'actions', '1', '--by', 'Dave', '--status', 'done');
    ok('someone else cannot update your line', r.status === 2 && /only sam updates this line/.test(r.stderr), r.stderr);
    r = run('update', 'm-abcd1', 'actions', '1', '--by', 'Sam', '--status', 'done 2026-11-19: priced', '--json');
    ok('the owner of a line updates it', r.status === 0 && JSON.parse(r.stdout).status === 'done 2026-11-19: priced', r.stderr);
    r = run('update', 'm-abcd1', 'actions', '1', '--by', 'Sam', '--plain', '');
    ok('an update that drops the plain line is refused', r.status !== 0, r.stdout + r.stderr);
    r = run('show', 'm-abcd1', '--json');
    ok('show lists the rows and what fails validation', r.status === 0 && JSON.parse(r.stdout).actions.length === 1 && Array.isArray(JSON.parse(r.stdout).problems), r.stderr);
    r = run('update', 'm-abcd1', 'rulings', '1', '--by', 'Sam', '--status', 'x');
    ok('a ruling is the owner\'s line', r.status === 2 && /only the owner updates/.test(r.stderr), r.stderr);
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
  console.log((fails ? 'FAIL ' : 'PASS ') + 'meeting-register selftest'); return fails ? 1 : 0;
}
if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { main, list };
