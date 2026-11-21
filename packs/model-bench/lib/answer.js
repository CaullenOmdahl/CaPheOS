'use strict';
// The answer contract: one fenced JSON block (```json ... ```). The last such block counts. Anything else is unparseable,
// which is an outright failure, never a partial score.
function extract(text) {
  const s = String(text == null ? '' : text);
  const re = /```json[ \t]*\r?\n([\s\S]*?)```/g;
  let m, last = null;
  while ((m = re.exec(s))) last = m[1];
  if (last == null) return { ok: false, error: 'no fenced json block' };
  try { return { ok: true, value: JSON.parse(last) }; } catch (e) { return { ok: false, error: 'the json block does not parse: ' + e.message.slice(0, 80) }; }
}
const fence = obj => '```json\n' + JSON.stringify(obj, null, 1) + '\n```';
// canonical text for exact matches: case, spaces, quotes and trailing dots do not count
function norm(v) {
  if (v == null) return '';
  return String(v).normalize('NFKC').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ').replace(/^[\s"'.]+|[\s"'.]+$/g, '').trim();
}
// numbers: currency symbols, thousands separators and spaces do not count; returns NaN when there is no number
function num(v) {
  if (typeof v === 'number') return v;
  let s = String(v == null ? '' : v).trim().replace(/[\s ]/g, '').replace(/^(EUR|GBP|USD|€|£|\$)/i, '').replace(/(EUR|GBP|USD|€|£|\$)$/i, '');
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
  return Number(s);
}
// dates: ISO yyyy-mm-dd, or a few common written forms
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function isoDate(v) {
  const s = norm(v);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (m) return s;
  m = s.match(/^(\d{1,2}) ([a-z]+),? (\d{4})$/); if (m && MONTHS.some(x => x.startsWith(m[2].slice(0, 3)))) return m[3] + '-' + String(MONTHS.findIndex(x => x.startsWith(m[2].slice(0, 3))) + 1).padStart(2, '0') + '-' + m[1].padStart(2, '0');
  m = s.match(/^([a-z]+) (\d{1,2}),? (\d{4})$/); if (m && MONTHS.some(x => x.startsWith(m[1].slice(0, 3)))) return m[3] + '-' + String(MONTHS.findIndex(x => x.startsWith(m[1].slice(0, 3))) + 1).padStart(2, '0') + '-' + m[2].padStart(2, '0');
  return null;
}
function same(a, b) {
  if (norm(a) === norm(b)) return true;
  const da = isoDate(a), db = isoDate(b); if (da && db) return da === db;
  const na = num(a), nb = num(b); if (!Number.isNaN(na) && !Number.isNaN(nb)) return Math.abs(na - nb) < 1e-9;
  return false;
}
module.exports = { extract, fence, norm, num, isoDate, same };
