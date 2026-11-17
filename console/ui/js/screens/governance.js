// Governance (Governance.dc.html): station autonomy, external gate, locked files, merge gate, governance log.
import { h, fill, Tag, Button, errLine, empty, screenHead, NOT_CONNECTED, rel } from '../ui.js';
import { api } from '../api.js';
import * as events from '../events.js';

export async function render(root, ctx) {
  root.className = 'main';
  const autonomy = h('div'), ext = h('div', { class: 'stack-14' }), locked = h('div', { class: 'stack-14' }), log = h('div', { class: 'stack-10' });
  fill(root,
    screenHead({ eyebrow: ['4 owner gates', 'Default is no'], title: 'Governance.', lede: 'What may leave the company, what must not change, and how much the crew may do without asking.', max: '760px' }),
    h('section', { 'aria-labelledby': 'auto', class: 'stack-14' },
      h('div', { class: 'between' }, h('h2', { id: 'auto', class: 'h3' }, 'Station autonomy, per action'), h('a', { href: '#/controls', class: 'body-s' }, 'Self-governance and guardrails →')),
      autonomy,
      h('div', { class: 'row-14 body-s', style: 'gap:20px' }, h('a', { href: '#/halt' }, 'Halt everything'))),
    h('section', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:24px' },
      h('article', { 'aria-labelledby': 'gate', class: 'card' },
        h('div', { class: 'between' }, h('h2', { id: 'gate', class: 'h4' }, 'External-action gate'), h('span', { class: 'mono muted' }, 'default: no')),
        h('p', { class: 'body-s muted' }, 'Every message, publication, account, form, payment or network call that leaves the company needs a clearance naming you or the CEO.'), ext),
      h('article', { 'aria-labelledby': 'lock', class: 'card', style: 'border-color:var(--rust-300)' },
        h('h2', { id: 'lock', class: 'h4' }, 'Locked files'),
        h('p', { class: 'body-s muted' }, 'Policy, gates, keys and StarNet code are hashed every tick. A change nobody recorded is reported to its owner with a one-command undo.'), locked),
      h('article', { 'aria-labelledby': 'merge', class: 'card' },
        h('h2', { id: 'merge', class: 'h4' }, 'Code: no push to a default branch'),
        h('p', { class: 'body-s muted' }, 'Agents keep full GitHub and Docker access. A merge needs a named reviewer and test evidence.'),
        h('p', { class: 'caption muted' }, 'Merge-gate status: ' + NOT_CONNECTED)),
      h('article', { 'aria-labelledby': 'changes', class: 'card' },
        h('h2', { id: 'changes', class: 'h4' }, 'Governance log'),
        h('p', { class: 'body-s muted' }, 'Every self-governance change, newest first (company/state/governance-log.jsonl).'), log)));

  // Station autonomy posture: read-only from the station if it answers
  (async () => {
    try {
      const d = await api('/station/autonomy');
      const cur = d.posture || d.mode || d.level || (d.autonomy && (d.autonomy.posture || d.autonomy.mode));
      const defs = [['wait', 'Wait', 'Ask before every action'], ['suggest', 'Suggest', 'Draft, then ask to apply'], ['small', 'Small jobs', 'Do routine work, ask on writes outside work/'], ['free', 'Free', 'Act, report after; gates still hold']];
      fill(autonomy, h('div', { role: 'radiogroup', 'aria-label': 'Station autonomy', class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px' },
        defs.map(([id, name, what]) => h('div', { role: 'radio', 'aria-checked': String(cur) .toLowerCase().startsWith(id) ? 'true' : 'false', 'aria-disabled': 'true', class: 'choice', style: 'min-height:72px;cursor:default' },
          h('span', { class: 'label' }, name), h('span', { class: 'caption' }, what)))),
        h('p', { class: 'caption muted', style: 'margin-top:8px' }, 'Shown from the station (' + (cur || 'unknown posture') + '). Changing it here is not connected yet.'));
    } catch (e) { fill(autonomy, e.stationDown ? errLine(e) : h('div', { class: 'empty' }, h('p', null, 'Station autonomy: ' + NOT_CONNECTED), errLine(e))); }
  })();

  const textOrRows = (host, d, mapRow) => {
    const rows = d.items || d.clearances || d.rows || d.files || d.drift || null;
    if (Array.isArray(rows)) return fill(host, rows.length ? h('ul', { class: 'plain' }, rows.slice(0, 30).map(mapRow)) : h('p', { class: 'body-s muted' }, 'Nothing listed.'));
    if (d.text) return fill(host, h('pre', { class: 'pre', style: 'max-height:280px' }, d.text));
    fill(host, h('pre', { class: 'pre', style: 'max-height:280px' }, JSON.stringify(d, null, 1)));
  };
  async function load() {
    api('/external').then(d => textOrRows(ext, d, c => h('li', { style: 'display:grid;grid-template-columns:96px minmax(0,1fr) auto;gap:12px;align-items:center;padding:12px 0', class: 'hair-top body-s' },
      Tag(c.category || c.cat || '?', { variant: 'mono' }), h('span', { class: 'strong' }, c.what || c.target || c.note || c.id || ''), h('span', { class: 'mono muted' }, c.by || '')))).catch(e => fill(ext, errLine(e, 'External gate')));
    api('/locked').then(d => textOrRows(locked, d, f => h('li', { class: 'sunken', style: 'margin-top:8px' }, h('span', { class: 'mono strong' }, f.path || f.file || ''), h('span', { class: 'caption muted' }, f.note || f.status || '')))).catch(e => fill(locked, errLine(e, 'Locked files')));
    // newest first, 12 at a time; "Load older" asks for the page before (GET /api/governance-log?cursor=)
    let all = [], cursor = null, shown = 12;
    const draw = () => {
      const ent = all.slice(0, shown);
      fill(log, ent.length ? h('div', null, h('ul', { class: 'plain stack-10 body-s' }, ent.map(x => h('li', { class: 'between' },
        h('span', { class: 'strong' }, [x.event || x.op, x.category, x.from && x.to ? x.from + ' → ' + x.to : x.level || x.preset].filter(Boolean).join(' · ') || JSON.stringify(x).slice(0, 80)),
        h('span', { class: 'mono muted' }, (x.by || '') + (x.at ? ' · ' + rel(x.at) : ''))))),
        all.length > shown || cursor != null ? Button('Load older', { size: 'sm', onClick: () => { shown += 50; if (all.length >= shown || cursor == null) return draw(); api('/governance-log?cursor=' + cursor).then(d => { all = all.concat((d.entries || []).slice().reverse()); cursor = d.more ? d.cursor : null; draw(); }).catch(e => log.appendChild(errLine(e, 'Governance log'))); } }) : null)
        : h('p', { class: 'body-s muted' }, 'No changes recorded yet.'));
    };
    api('/governance-log').then(d => { all = (d.entries || []).slice().reverse(); cursor = d.more ? d.cursor : null; draw(); }).catch(e => fill(log, errLine(e, 'Governance log')));
  }
  load();
  const off = events.on('governance', load);
  return () => off();
}
