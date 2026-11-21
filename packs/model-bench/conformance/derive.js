'use strict';
/* File-based checks: does each generator's expected answer follow from the files the model is actually given?
 *
 * "The oracle passes and the known-bad answer fails" only shows that a scorer agrees with the generator's own expected
 * value. These checks re-derive answers from the generated files with code written apart from the generators, so an
 * expected value that the files do not support is caught. Offline, pure: no model, no shell.
 *   kind 1: every answer is in the file it is said to come from (or, with no path, in some file)
 *   kind 2: every extracted value is in the source text (the amendment's, for a field it changes)
 *   kind 3: a note that names only an internal identifier (not the whole phrase) fails layer 1
 *   kind 5: lookup values are cells of the table; deep totals and discrepancies are reconciled from the two CSVs
 *   kind 9: lookup answers are recomputed from the report files and the ledger
 * derive(unitDir, tasks, seeds) -> [problem] */
const B = require('../lib/bench');

const flat = s => String(s).toLowerCase().replace(/,/g, '').replace(/\s+/g, ' ');
const textOf = v => typeof v === 'string' ? v : (v && v.text) || '';
const cents = s => Math.round(Number(String(s).replace(/,/g, '')) * 100);
const csv = t => t.trim().split('\n').slice(1).map(l => l.split(','));

function k1(inst) {
  const out = [];
  for (const it of inst.expected.items) {
    if (it.notFound) continue;
    const vals = [it.value].concat(it.also || []).map(flat);
    const where = it.path ? [it.path] : Object.keys(inst.files);
    const hit = where.some(p => inst.files[p] != null && vals.some(v => flat(textOf(inst.files[p])).includes(v)));
    if (!hit) out.push(it.id + ': ' + JSON.stringify(it.value) + ' is not in ' + (it.path || 'any file'));
  }
  return out;
}
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function dateForms(iso) {
  const [y, m, d] = iso.split('-'), mn = MONTHS[Number(m) - 1];
  return [iso, Number(d) + ' ' + mn + ' ' + y, mn + ' ' + Number(d) + ' ' + y, d + '/' + m + '/' + y, Number(d) + '/' + Number(m) + '/' + y].map(flat);
}
function k2(inst) {
  const out = [], src = flat(Object.values(inst.files).map(textOf).join('\n') + '\n' + (inst.expected.sourceText || ''));
  for (const [k, v] of Object.entries(inst.expected.fields || {})) {
    if (v == null) continue;
    const vals = Array.isArray(v) ? v : [v];
    for (const x of vals) {
      const t = (inst.expected.types || {})[k];
      const forms = t === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(x) ? dateForms(x)
        : t === 'money' ? [flat(x), flat(String(Number(x)))] : [flat(x)];
      if (!forms.some(f => src.includes(f))) out.push(k + ': ' + JSON.stringify(x) + ' is not in the source files');
    }
  }
  return out;
}
async function k3(unitDir, task, inst) {
  // the internal references are read from the handoff itself ("ctx: <topic> -- see <a>, also <b>."), and every
  // identifier-shaped part of them (V-208, costs-2026.xlsx, jobs/print-queue.js) is tried alone in the oracle note
  const out = [], exp = inst.expected, sc = require(require('path').join(unitDir, task.scorer.name));
  const note = inst.oracle && inst.oracle.answer && inst.oracle.answer.note, h = textOf(inst.files['handoff.md']);
  const m = h.match(/^ctx: .*? -- see (.*?)\.(?:\s|$)/m);
  if (!note || !m) return out;
  const ids = new Set();
  for (const ph of m[1].split(/, also | and /)) for (const x of ph.matchAll(/\b[A-Z]+-\d+\b|[\w.-]+\/[\w./-]+|\b[\w-]+\.(?:js|md|csv|xlsx)\b|\b(?:error|server|level) \d+\b/g)) { ids.add(x[0]); if (x[0].includes('/')) ids.add(x[0].split('/').pop()); }
  if (!ids.size) out.push('no internal identifier found in the handoff');
  for (const id of ids) {
    // put the bare identifier in a middle sentence, so length and the closing ask still hold
    const s = note.split('. '); s.splice(1, 0, 'For the record it was ' + id);
    const r = await sc.score({ note: s.join('. ') }, exp, {});
    if (!/internal detail|a file path/.test(String(r.detail))) out.push('a note naming only ' + JSON.stringify(id) + ' passes layer 1');
  }
  return out;
}
function k5(inst, task) {
  const out = [], exp = inst.expected;
  if (task.depth === 'lookup') {
    const want = Math.round(exp.value * 100);
    const cells = textOf(inst.files['finance/q1-invoices.md']).split('\n').filter(l => /^\| /.test(l)).flatMap(l => l.split('|').map(c => c.trim())).filter(c => /^[\d,]+\.\d{2}$/.test(c)).map(cents);
    if (!cells.includes(want)) out.push('the looked-up value ' + exp.value + ' is not a cell of the table');
  }
  if (task.depth === 'deep') {
    // reconcile the two CSVs by the rules in finance/README.md and the prompt, without the generator's flags
    const L = csv(textOf(inst.files['finance/ledger-q1.csv'])), Bk = csv(textOf(inst.files['finance/bank-q1.csv']));
    const inQ1 = d => d >= '2026-01-01' && d <= '2026-03-31';
    const seen = new Map(), found = [];
    for (const [id, date, , amt] of L) { if (seen.has(id)) { found.push({ ref: id, type: 'duplicate' }); continue; } seen.set(id, { date, booked: cents(amt) }); }
    const paid = new Map(Bk.map(([, ref, amt]) => [ref, cents(amt)]));
    const swaps = n => { const s = String(n), o = new Set(); for (let i = 0; i < s.length - 1; i++) if (s[i] !== s[i + 1]) o.add(Number(s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2))); return o; };
    let net = 0;
    for (const [id, x] of seen) {
      if (!inQ1(x.date)) { found.push({ ref: id, type: 'period' }); continue; }
      const got = paid.get(id);
      let trueNet = x.booked;
      if (got != null) {
        if (got === x.booked) { found.push({ ref: id, type: 'vat' }); trueNet = Math.round(x.booked / 1.2); }
        else if (got !== Math.round(x.booked * 1.2)) { if (swaps(Math.round(x.booked * 1.2)).has(got)) found.push({ ref: id, type: 'transposed' }); else found.push({ ref: id, type: 'unexplained' }); }
      }
      net += trueNet;
    }
    for (const ref of paid.keys()) if (!seen.has(ref)) found.push({ ref, type: 'missing' });
    const received = Bk.reduce((a, r) => a + cents(r[2]), 0);
    if (Math.round(exp.values.q1_net_invoiced * 100) !== net) out.push('q1_net_invoiced: the files give ' + (net / 100).toFixed(2) + ', expected says ' + exp.values.q1_net_invoiced);
    if (Math.round(exp.values.q1_received * 100) !== received) out.push('q1_received: the files give ' + (received / 100).toFixed(2) + ', expected says ' + exp.values.q1_received);
    const key = x => x.ref + ':' + x.type, a = new Set(found.map(key)), b = new Set(exp.discrepancies.map(key));
    for (const k of a) if (!b.has(k)) out.push('the files show ' + k + ', which expected does not list');
    for (const k of b) if (!a.has(k)) out.push('expected lists ' + k + ', which the files do not show');
  }
  return out;
}
function k9(inst, task) {
  if (task.depth !== 'lookup') return [];
  const reports = Object.entries(inst.files).filter(([p]) => /^reports\/.*\.md$/.test(p)).map(([, t]) => textOf(t));
  const field = (t, k) => (t.match(new RegExp('^' + k + ': (.*)$', 'm')) || [])[1];
  const ledger = csv(textOf(inst.files['reports/ledger.csv']));
  const q = inst.prompt, want = String(inst.expected.answer.answer);
  let got = null, m;
  if (/status OVERDUE/.test(q)) got = String(reports.filter(t => field(t, 'Status') === 'OVERDUE').length);
  else if (/sum of the amount column/.test(q)) got = (ledger.reduce((a, r) => a + cents(r[2]), 0) / 100).toFixed(2);
  else if ((m = q.match(/Which client is invoice (\S+) for/))) got = field(reports.find(t => field(t, 'Invoice') === m[1]) || '', 'Client');
  else if (/How many report files \(\.md\)/.test(q)) got = String(reports.length);
  else if (/largest amount/.test(q)) got = (Math.max(...ledger.map(r => cents(r[2]))) / 100).toFixed(2);
  else if ((m = q.match(/How many invoices in reports\/ledger\.csv are for (.+)\?/))) got = String(ledger.filter(r => r[1] === m[1]).length);
  else return ['no file-based check for this question: ' + q.slice(0, 80)];
  return got === want ? [] : ['the files give ' + JSON.stringify(got) + ', expected says ' + JSON.stringify(want)];
}

async function derive(unitDir, tasks, seeds) {
  const problems = [];
  for (const t of tasks) {
    if (![1, 2, 3, 5, 9].includes(t.kind)) continue;
    for (const seed of seeds) {
      const inst = B.instantiate(unitDir, t, seed);
      const p = t.kind === 1 ? k1(inst) : t.kind === 2 ? k2(inst) : t.kind === 3 ? await k3(unitDir, t, inst) : t.kind === 5 ? k5(inst, t) : k9(inst, t);
      for (const x of p) problems.push(t.id + ' (seed ' + seed + '): ' + x);
    }
  }
  return problems;
}
module.exports = { derive };
