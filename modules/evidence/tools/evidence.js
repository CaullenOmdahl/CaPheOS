#!/usr/bin/env node
/* evidence.js — a per-party trail the company can hand over in a dispute, with a digest for every file in it.
 *
 *   node evidence.js export --party <id> --from YYYY-MM-DD --to YYYY-MM-DD [--out <dir>] [--no-zip]
 *   node evidence.js check <folder>        re-hash every file against manifest.json; exit 1 on any difference
 *   node evidence.js --selftest
 *
 * The export folder (default company/work/evidence/<party>/<from>_<to>/) holds, each as JSONL:
 *   events.jsonl          intake events for the party (company/work/intake/events.jsonl)
 *   observe.jsonl         observe results that name the party (company/work/observe/*.jsonl)
 *   commitments.jsonl     every commitment of the party touched in the window, with its full history
 *   transitions.jsonl     commitments.jsonl transition rows for those commitments
 *   verify.jsonl          verify results (company/work/verify/results.jsonl)
 *   external-gate.jsonl   external-gate decisions and clearance rows that mention the party or its commitments
 *   provenance.jsonl      provenance rows for files under the party's folders
 *   ledger.jsonl          revenue ledger rows for the party (company/work/ledger/ledger.jsonl)
 * plus manifest.json ({party, from, to, generatedAt, files:[{file, rows, bytes, sha256}], manifestSha256}) and a zip of
 * the folder beside it (<folder>.zip). Reading only: an export changes nothing it reads. Owner: the risk function.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const S = require((() => { let d = __dirname; for (let i = 0; i < 6; i++, d = path.dirname(d)) { const f = path.join(d, 'company', 'tools', 'lib', 'settle.js'); if (fs.existsSync(f)) return f; } return path.join(__dirname, 'lib', 'settle.js'); })());
const co = S.co;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
function window(from, to) {
  if (!DAY.test(String(from || '')) || !DAY.test(String(to || ''))) throw new Error('--from and --to are YYYY-MM-DD');
  const a = Date.parse(from + 'T00:00:00Z'), b = Date.parse(to + 'T23:59:59.999Z');
  if (!(a <= b)) throw new Error('--from is after --to');
  return { a, b, in: at => { const t = Date.parse(at); return Number.isFinite(t) && t >= a && t <= b; } };
}
const mentions = (row, needles) => { const s = JSON.stringify(row); return needles.some(n => n && s.includes(n)); };

function collect(party, w) {
  const files = {};
  const ev = S.readJsonl(S.work('intake', 'events.jsonl'));
  files['events.jsonl'] = ev.filter(e => e.party === party && w.in(e.at));
  let obs = []; try { for (const f of fs.readdirSync(S.work('observe')).filter(f => f.endsWith('.jsonl'))) obs = obs.concat(S.readJsonl(S.work('observe', f)).map(r => Object.assign({ _target: f.replace(/\.jsonl$/, '') }, r))); } catch (_) {}
  files['observe.jsonl'] = obs.filter(r => r.party === party && w.in(r.at));
  const cs = S.commitments({ archived: true }).filter(c => c.party === party && ((c.history || []).some(h => w.in(h.at)) || w.in(c.createdAt)));
  files['commitments.jsonl'] = cs;
  const ids = new Set(cs.map(c => c.id));
  files['transitions.jsonl'] = S.readJsonl(S.work('commitments', 'commitments.jsonl')).filter(r => ids.has(r.id || r.commitment) && w.in(r.at));
  files['verify.jsonl'] = S.readJsonl(S.work('verify', 'results.jsonl')).filter(r => (r.party === party || ids.has(r.commitment)) && w.in(r.at));
  const needles = ['party:' + party, '"party":"' + party + '"', '/parties/' + party + '/'].concat([...ids]);
  const gateRows = S.readJsonl(S.work('external-actions.jsonl')).map(r => Object.assign({ _file: 'company/work/external-actions.jsonl' }, r))
    .concat(S.readJsonl(co.p('company', 'state', 'external-clearances.jsonl')).map(r => Object.assign({ _file: 'company/state/external-clearances.jsonl' }, r)));
  files['external-gate.jsonl'] = gateRows.filter(r => w.in(r.at || r.clearedAt || r.recordedAt) && mentions(r, needles));
  files['provenance.jsonl'] = S.readJsonl(co.p('company', 'state', 'locked', 'provenance.jsonl'))
    .filter(r => w.in(r.at) && mentions(r, ['/parties/' + party + '/', 'reports/' + party + '/', 'evidence/' + party + '/']));
  files['ledger.jsonl'] = S.readJsonl(S.work('ledger', 'ledger.jsonl')).filter(r => r.party === party && w.in(r.at));
  return files;
}
function zipDir(dir, zipFile) {
  const py = 'import sys,os,zipfile\nd,z=sys.argv[1],sys.argv[2]\nwith zipfile.ZipFile(z,"w",zipfile.ZIP_DEFLATED) as f:\n  for n in sorted(os.listdir(d)):\n    f.write(os.path.join(d,n),os.path.join(os.path.basename(d),n))\n';
  const r = require('child_process').spawnSync('python3', ['-I', '-c', py, dir, zipFile], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('zip failed: ' + (r.stderr || '').trim().split('\n').pop());
  return zipFile;
}
function exportParty(o) {
  const party = String(o.party || ''); if (!S.ID_RE.test(party)) throw new Error('--party <id> is required');
  const w = window(o.from, o.to);
  const dir = o.out ? path.resolve(o.out) : S.work('evidence', party, o.from + '_' + o.to);
  fs.mkdirSync(dir, { recursive: true });
  const files = collect(party, w);
  const man = { party, from: o.from, to: o.to, generatedAt: new Date().toISOString(), generatedBy: 'evidence.js', files: [] };
  for (const [name, rows] of Object.entries(files)) {
    const txt = rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
    fs.writeFileSync(path.join(dir, name), txt);
    man.files.push({ file: name, rows: rows.length, bytes: Buffer.byteLength(txt), sha256: S.sha256(txt) });
  }
  man.manifestSha256 = S.sha256(JSON.stringify(man.files));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(man, null, 2) + '\n');
  const zip = o.zip === false ? null : zipDir(dir, dir + '.zip');
  return { ok: true, dir: path.relative(co.ROOT, dir) || dir, zip: zip && (path.relative(co.ROOT, zip) || zip), zipSha256: zip ? S.sha256(fs.readFileSync(zip)) : null,
    counts: Object.fromEntries(man.files.map(f => [f.file, f.rows])), manifestSha256: man.manifestSha256 };
}
function check(dir) {
  const man = S.readJson(path.join(dir, 'manifest.json'), null); if (!man) return { ok: false, problems: ['manifest.json unreadable'] };
  const problems = [];
  for (const f of man.files || []) { let b; try { b = fs.readFileSync(path.join(dir, f.file)); } catch (_) { problems.push(f.file + ' missing'); continue; } if (S.sha256(b) !== f.sha256) problems.push(f.file + ' digest differs'); }
  if (S.sha256(JSON.stringify(man.files || [])) !== man.manifestSha256) problems.push('manifest file list digest differs');
  return { ok: !problems.length, problems };
}

function selftest() {
  return S.selftest(__filename, ok => {
    const at = '2026-03-05T10:00:00.000Z', late = '2026-05-01T00:00:00.000Z';
    S.appendJsonl(S.work('intake', 'events.jsonl'), { id: 'e1', at, source: 'hook', type: 'order', key: 'k1', party: 'acme', data: {}, receivedVia: 'http' });
    S.appendJsonl(S.work('intake', 'events.jsonl'), { id: 'e2', at, source: 'hook', type: 'order', key: 'k2', party: 'beta', data: {}, receivedVia: 'http' });
    S.appendJsonl(S.work('intake', 'events.jsonl'), { id: 'e3', at: late, source: 'hook', type: 'order', key: 'k3', party: 'acme', data: {}, receivedVia: 'http' });
    S.writeJson(S.work('commitments', 'c-202603051000-aaaaa1.json'), { id: 'c-202603051000-aaaaa1', key: 'k1', party: 'acme', title: 'job', state: 'verified', owner: 'sam', createdAt: at, history: [{ at, from: null, to: 'received', by: 'intake' }], evidence: [] });
    S.writeJson(S.work('commitments', 'c-202603051000-aaaaa2.json'), { id: 'c-202603051000-aaaaa2', key: 'k2', party: 'beta', title: 'other', state: 'done', owner: 'sam', createdAt: at, history: [{ at, from: null, to: 'received', by: 'intake' }], evidence: [] });
    S.appendJsonl(S.work('commitments', 'commitments.jsonl'), { at, id: 'c-202603051000-aaaaa1', from: null, to: 'received', by: 'intake' });
    S.appendJsonl(S.work('verify', 'results.jsonl'), { at, commitment: 'c-202603051000-aaaaa1', party: 'acme', outcome: 'pass' });
    S.appendJsonl(S.work('external-actions.jsonl'), { at, decision: 'allowed', category: 'message', target: 'email:a@acme.example', note: 'report party:acme' });
    S.appendJsonl(S.work('external-actions.jsonl'), { at, decision: 'allowed', category: 'message', target: 'email:b@beta.example', note: 'party:beta' });
    S.appendJsonl(S.work('ledger', 'ledger.jsonl'), { at, type: 'invoice', party: 'acme', amount: 10 });
    const r = exportParty({ party: 'acme', from: '2026-03-01', to: '2026-03-31' });
    ok('export writes folder and zip', fs.existsSync(path.join(co.ROOT, r.dir, 'manifest.json')) && fs.existsSync(path.join(co.ROOT, r.zip)), r);
    ok('only the party, only the window', r.counts['events.jsonl'] === 1 && r.counts['commitments.jsonl'] === 1 && r.counts['transitions.jsonl'] === 1, r.counts);
    ok('verify, gate and ledger rows included', r.counts['verify.jsonl'] === 1 && r.counts['external-gate.jsonl'] === 1 && r.counts['ledger.jsonl'] === 1, r.counts);
    ok('manifest digests check', check(path.join(co.ROOT, r.dir)).ok);
    fs.appendFileSync(path.join(co.ROOT, r.dir, 'events.jsonl'), '{"forged":true}\n');
    ok('a changed file is caught', !check(path.join(co.ROOT, r.dir)).ok);
    const z = require('child_process').spawnSync('unzip', ['-l', path.join(co.ROOT, r.zip)], { encoding: 'utf8' });
    ok('zip holds the manifest', z.status !== 0 || /manifest\.json/.test(z.stdout));
    let e = ''; try { exportParty({ party: 'acme', from: '2026-04-01', to: '2026-03-01' }); } catch (x) { e = x.message; }
    ok('a backwards window is refused', /after/.test(e));
  });
}

if (require.main === module) {
  const a = S.args(); const cmd = a._[0] || (a.selftest ? 'selftest' : '');
  try {
    if (cmd === 'selftest') selftest();
    else if (cmd === 'export') S.out(0, exportParty({ party: a.party, from: a.from, to: a.to, out: a.out, zip: !a['no-zip'] }));
    else if (cmd === 'check') { const r = check(path.resolve(String(a._[1] || ''))); S.out(r.ok ? 0 : 1, r); }
    else S.out(2, { ok: false, error: 'commands: export, check, --selftest' });
  } catch (e) { S.out(1, { ok: false, error: e.message }); }
}
module.exports = { exportParty, check, collect };
