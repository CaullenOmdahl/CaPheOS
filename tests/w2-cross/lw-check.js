// locked-watch on a fixture: baseline, then routing.js changes (owner), then a router record, then a tick
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'); const { spawnSync } = require('child_process');
const REPO = process.env.E2E_REPO, TOOLS = path.join(REPO, 'company', 'tools');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-lw-'));
fs.cpSync(path.join(REPO, 'company'), path.join(T, 'company'), { recursive: true, filter: s => !/\.starnet-data/.test(s) });
for (const f of ['company/state/locked/provenance.jsonl', 'company/work/models/routing-policy.json', 'company/work/models/routing-log.jsonl']) try { fs.rmSync(path.join(T, f)); } catch (_) {}
const w = (rel, d) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof d === 'string' ? d : JSON.stringify(d, null, 1)); };
w('company/company.json', { name: 'LW Co', slug: 'lw', timezone: 'UTC', owner: { name: 'Olive' }, station: { url: 'http://127.0.0.1:9' } });
w('company/tools/loops.json', { agents: { boss: { name: 'Boss', functions: ['ceo', 'tools', 'risk'], inbox: 'to-boss.md', manager: null }, hal: { name: 'Hal', functions: ['people'], inbox: 'to-hal.md', manager: 'boss' } } });
w('company/work/decisions.md', '# Decisions\n\n');
const env = Object.assign({}, process.env, { CAPHEOS_ROOT: T, CAPHEOS_TZ: 'UTC', STARNET_URL: 'http://127.0.0.1:9', LOCKED_WATCH_HOME: path.join(T, 'guard-home'), PROVENANCE_ROOT: T });
const lw = (...a) => spawnSync(process.execPath, [path.join(TOOLS, 'locked-watch.js'), ...a], { cwd: T, env, encoding: 'utf8', timeout: 120000 });
const PRE = path.join(T, 'pin-owner.js'); fs.writeFileSync(PRE, 'const prov=require(' + JSON.stringify(path.join(TOOLS, 'provenance.js')) + ');prov.pinUnderStation(false);prov.pinOwnerShell(true);\n');
fs.writeFileSync(path.join(T, '.capheos-selftest-fixture'), '');
const rt = (argv) => { const p = spawnSync(process.execPath, [ path.join(TOOLS, 'routing.js'), ...argv], { cwd: T, env, encoding: 'utf8' }); return { code: p.status, out: p.stdout.slice(0, 200) }; };
// status: how many manifest entries name routing-policy.json
const st = lw('status', '--json'); const sj = (() => { try { return JSON.parse(st.stdout); } catch (_) { return null; } })();
const LW = require(path.join(TOOLS, 'locked-watch.js'));
const M = LW.MANIFEST || (LW._internals && LW._internals.MANIFEST);
console.log('manifest exported:', !!M);
if (M) { console.log('entries for routing-policy.json:', M.filter(m => m.p === 'company/work/models/routing-policy.json').length, ' lib/routing.js:', M.filter(m => m.p === 'company/tools/lib/routing.js').length, ' routing-log:', JSON.stringify(M.filter(m => m.p === 'company/work/models/routing-log.jsonl').map(m => m.writers))); }
let r = lw('baseline', '--force'); console.log('baseline', r.status, (r.stdout + r.stderr).slice(-300));
r = lw('tick'); console.log('tick0', r.status);
console.log('mode live:', rt(['mode', 'live', '--by', 'owner']).code);
console.log('tiercaps live:', rt(['tiercaps', 'live', '--by', 'owner']).code);
const RL = require(path.join(TOOLS, 'lib', 'routing.js'));
RL.record({ root: T, K: { history: 'company/work/models/routing-log.jsonl' }, dry: false }, { wakeId: 'wk-1', seat: 'hal', route: { v: 1 } });
const before = fs.readFileSync(path.join(T, 'company/work/models/routing-log.jsonl'), 'utf8');
r = lw('tick'); console.log('tick1', r.status, (r.stdout + r.stderr).split('\n').filter(l => /routing/.test(l)).join('\n').slice(0, 2000));
const after = fs.readFileSync(path.join(T, 'company/work/models/routing-log.jsonl'), 'utf8');
console.log('log rows before tick:', before.trim().split('\n').map(l => JSON.parse(l).op || 'router-row').join(','));
console.log('log rows after tick :', after.trim().split('\n').map(l => JSON.parse(l).op || 'router-row').join(','));
console.log('policy mode after tick:', JSON.parse(fs.readFileSync(path.join(T, 'company/work/models/routing-policy.json'))).mode);
const chg = path.join(T, 'company/work/security/locked-changes.jsonl'); if (fs.existsSync(chg)) console.log('locked-changes:', fs.readFileSync(chg, 'utf8').split('\n').filter(l => /routing/.test(l)).map(l => l.slice(0, 300)).join('\n'));
console.log('ROOT', T);
