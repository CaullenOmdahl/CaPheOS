#!/usr/bin/env node
/* continuity.js — wind-down and handover from a shell (module continuity, modules/continuity/lib.js).
 *
 *   node company/tools/continuity.js open [--json]                 open commitments by party and due time
 *   node company/tools/continuity.js unowned [--json]              breach-able commitments nobody holds (they block a soft-halt settle)
 *   node company/tools/continuity.js reassign <id> --to <seat> --by owner
 *   node company/tools/continuity.js notify <party> --text ".." --by owner     gated: external-gate category message
 *   node company/tools/continuity.js --selftest
 */
'use strict';
const fs = require('fs');
const path = require('path');
const co = require(fs.existsSync(path.join(__dirname, 'lib', 'company.js')) ? './lib/company' : '../../../company/tools/lib/company');
const a = process.argv.slice(2);
const opt = k => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };
if (a.includes('--selftest')) process.exit(selftest());
const lib = require(co.p('modules', 'continuity', 'lib.js'));
const out = (r, human) => { if (a.includes('--json') || !human) console.log(JSON.stringify(r, null, 1)); else human(r); process.exit(r.ok === false ? 1 : 0); };
const cmd = a[0] || 'open';
if (cmd === 'open') out(lib.open(), r => { if (!r.count) console.log('no open commitments'); for (const [p, cs] of Object.entries(r.byParty)) { console.log(p); for (const c of cs) console.log('  ' + (c.dueAt || '-').padEnd(25) + ' ' + c.id + ' ' + c.state + ' owner ' + (c.owner || 'NONE') + (c.ownerOk ? '' : ' (unowned)') + ' — ' + c.title); } });
else if (cmd === 'unowned') { const u = lib.unowned(); out({ ok: true, count: u.length, unowned: u }, r => { console.log(r.count ? r.count + ' unowned breach-able commitment(s):' : 'none unowned'); for (const c of r.unowned) console.log('  ' + c.id + ' due ' + (c.dueAt || c.ackBy) + ' — ' + c.title); }); }
else if (cmd === 'reassign') { if (!a[1] || !opt('to')) { console.error('reassign <id> --to <seat> --by owner'); process.exit(2); } if (String(opt('by') || '').toLowerCase() !== 'owner' && opt('by') !== (co.config.owner || {}).name) { console.log(JSON.stringify({ ok: false, error: 'only the owner reassigns during a wind-down' })); process.exit(1); } out(lib.reassign(a[1], opt('to'), opt('by'))); }
else if (cmd === 'notify') { if (!a[1] || !opt('text')) { console.error('notify <party> --text ".." --by owner'); process.exit(2); } out(lib.notify(a[1], opt('text'), opt('by') || 'owner')); }
else { console.error('usage: continuity.js open|unowned|reassign|notify|--selftest'); process.exit(2); }

function selftest() {
  const os = require('os'); const { spawnSync } = require('child_process');
  const here = path.resolve(co.p('modules', 'continuity'));
  const repo = path.resolve(here, '..', '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-selftest-'));
  let fails = 0, n = 0; const t = (name, ok, x) => { n++; if (!ok) fails++; console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok || x === undefined ? '' : ' :: ' + String(x).slice(0, 600))); };
  try {
    for (const d of ['company/tools/lib', 'company/state', 'company/owner', 'company/work/commitments', 'modules/continuity']) fs.mkdirSync(path.join(tmp, d), { recursive: true });
    for (const f of ['lib/company.js', 'halt.js']) fs.copyFileSync(path.join(repo, 'company', 'tools', f), path.join(tmp, 'company', 'tools', f));
    for (const f of ['lib.js', 'http.js']) fs.copyFileSync(path.join(here, f), path.join(tmp, 'modules', 'continuity', f));
    fs.writeFileSync(path.join(tmp, 'company', 'company.json'), JSON.stringify({ name: 'Test Co', owner: { name: 'Alex' }, timezone: 'UTC' }));
    fs.writeFileSync(path.join(tmp, 'company', 'tools', 'loops.json'), JSON.stringify({ agents: { 'a-ceo': { name: 'Sam', manager: null, functions: ['ceo'] } } }));
    fs.writeFileSync(path.join(tmp, 'company', 'tools', 'external-gate.js'), "module.exports={check:({target})=>target==='party:p-ok'?{allow:true,clearanceId:'c1'}:{allow:false,reason:'no clearance row'}};\n");
    fs.writeFileSync(path.join(tmp, 'company', 'state', 'modules.json'), JSON.stringify({ enabled: { continuity: {} } }));
    const C = (id, o) => fs.writeFileSync(path.join(tmp, 'company', 'work', 'commitments', id + '.json'), JSON.stringify(Object.assign({ id, key: id, title: 'job ' + id, state: 'acknowledged', history: [] }, o)));
    C('c-1', { party: 'p-ok', owner: 'a-ceo', dueAt: '2030-01-02T00:00:00Z' });
    C('c-2', { party: 'p-two', owner: null, dueAt: '2030-01-01T00:00:00Z' });
    C('c-3', { party: 'p-two', owner: 'gone-seat', state: 'closed', dueAt: '2030-01-01T00:00:00Z' });
    C('c-4', { party: 'p-two', owner: 'gone-seat', ackBy: '2030-01-03T00:00:00Z', state: 'received' });
    const env = Object.assign({}, process.env, { CAPHEOS_ROOT: tmp });
    const js = code => { const r = spawnSync(process.execPath, ['-e', code], { cwd: tmp, encoding: 'utf8', env, timeout: 60000 }); let j = null; try { j = JSON.parse(r.stdout.trim().split('\n').pop()); } catch (_) {} return { j, out: r.stdout + r.stderr }; };
    let r = js("const l=require('./modules/continuity/lib.js');console.log(JSON.stringify({o:l.open(),u:l.unowned().map(c=>c.id)}))");
    t('open: closed ones left out, sorted by due, grouped by party', r.j && r.j.o.count === 3 && r.j.o.commitments[0].id === 'c-2' && r.j.o.byParty['p-two'].length === 2, r.out);
    t('unowned: no owner, or an owner who is not a seat', r.j && JSON.stringify(r.j.u.sort()) === '["c-2","c-4"]', r.out);
    r = js("const l=require('./modules/continuity/lib.js');console.log(JSON.stringify([l.notify('p-two','we are winding down','owner'),l.notify('p-ok','we are winding down','owner')]))");
    t('notify: refused without a clearance, queued with one', r.j && r.j[0].ok === false && r.j[0].gated && r.j[1].ok === true && fs.readFileSync(path.join(tmp, 'company', 'work', 'continuity', 'notices.jsonl'), 'utf8').includes('p-ok'), r.out);
    r = js("const l=require('./modules/continuity/lib.js');console.log(JSON.stringify(l.reassign('c-2','a-ceo','owner')))");
    t('reassign refused while the commitments module is off', r.j && r.j.ok === false && /not enabled/.test(r.j.error), r.out);
    // halt.js: soft snapshots commitments; tick does not settle while one is unowned
    const fake = "const h=require('./company/tools/halt.js');h.S.call=async(m,p)=>({status:200,body:JSON.stringify(p==='/api/cron'?{enabled:true,jobs:[]}:p==='/api/state/snapshot'?{runs:[]}:p==='/api/loops'?{loops:[]}:{ok:true})});h.S.notify=t=>require('fs').appendFileSync('company/owner/outbound.jsonl',JSON.stringify({text:t})+'\\n');";
    r = js(fake + "(async()=>{const s=await h.soft({by:'Alex',why:'test'});const t1=await h.tick({});console.log(JSON.stringify({snap:s.commitments,t1}))})()");
    t('halt.js soft lists open commitments by party', r.j && r.j.snap && r.j.snap.count === 3 && r.j.snap.byParty['p-two'], r.out);
    t('halt.js tick refuses to settle while a breach-able commitment is unowned', r.j && r.j.t1.action === 'waiting' && r.j.t1.left.some(x => /c-2.*unowned/.test(x)), r.out);
    C('c-2', { party: 'p-two', owner: 'a-ceo', dueAt: '2030-01-01T00:00:00Z' }); C('c-4', { party: 'p-two', owner: 'a-ceo', state: 'received', ackBy: '2030-01-03T00:00:00Z' });
    r = js(fake + "(async()=>{console.log(JSON.stringify(await h.tick({})))})()");
    t('halt.js tick settles once every commitment is owned', r.j && r.j.action === 'settled', r.out);
    fs.writeFileSync(path.join(tmp, 'company', 'state', 'modules.json'), JSON.stringify({ enabled: {} }));
    C('c-2', { party: 'p-two', owner: null, dueAt: '2030-01-01T00:00:00Z' });
    r = js(fake + "(async()=>{await h.resume({by:'Alex'});await h.soft({by:'Alex'});console.log(JSON.stringify(await h.tick({})))})()");
    t('continuity not enabled: halt.js ignores commitments', r.j && r.j.action === 'settled', r.out);
  } catch (e) { t('selftest crashed', false, e.stack); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log((fails ? 'FAIL ' : 'PASS ') + (n - fails) + '/' + n);
  return fails ? 1 : 0;
}
