// Settings › How the crew talks to you (#/settings/talk; console/talk.js, docs/TALK.md): three cards for the level, each
// with a fixed example (a progress update, switchable to a problem or an ask), the length (the example re-renders at it)
// and how often. Saving runs company/tools/talk.js set as the owner; nothing is asked of a model.
import { h, fill, Button, errLine, loading, Block } from '../../ui.js';
import { api, post } from '../../api.js';
import * as W from './talk-words.js';

export async function render(host, ctx) {
  const app = (ctx && ctx.app) || { toast: () => {} };
  fill(host, loading());
  let d; try { d = await api('/settings/talk'); } catch (e) { fill(host, errLine(e, W.SECTION)); return; }
  const ex = (d.examples && Array.isArray(d.examples.messages) ? d.examples.messages : []);
  const st = { level: d.prefs.level, length: d.prefs.length, often: d.prefs.often, msg: (ex[0] && ex[0].id) || 'progress' };
  if (!d.picked) { st.level = 'plain'; st.length = 'short'; }   // what a new company starts on, shown until they save
  const exampleOf = (level, length) => { const m = ex.find(x => x.id === st.msg) || ex[0]; return m && m.levels && m.levels[level] ? m.levels[level][length] || '' : ''; };
  const levels = h('div', { role: 'radiogroup', 'aria-label': W.LEVEL_TITLE, class: 'grid talk-levels', style: 'grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:12px' });
  const lengths = h('div', { role: 'radiogroup', 'aria-label': W.LENGTH_TITLE, class: 'row-8 talk-lengths', style: 'flex-wrap:wrap' });
  const often = h('div', { role: 'radiogroup', 'aria-label': W.OFTEN_TITLE, class: 'grid talk-often', style: 'grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr));gap:10px' });
  const msgs = h('div', { role: 'radiogroup', 'aria-label': W.EXAMPLE_PICK, class: 'row-8 talk-msgs', style: 'flex-wrap:wrap' });
  const radio = (on, label, cls, pick, extra) => h('button', { type: 'button', role: 'radio', class: 'choice ' + cls, 'aria-checked': on ? 'true' : 'false', onclick: pick }, label, extra || null);
  function draw() {
    fill(levels, W.LEVELS.map(([id, name, tag, what]) => radio(st.level === id, h('span', { class: 'row-8', style: 'align-items:center' }, h('span', { class: 'label' }, name), tag ? h('span', { class: 'caption' }, '(' + tag + ')') : null), 'talk-level',
      () => { st.level = id; draw(); },
      h('span', { class: 'stack-6', style: 'text-align:left' }, h('span', { class: 'caption' }, what),
        h('span', { class: 'caption muted' }, id === 'technical' ? W.TECH_PREVIEW : W.EXAMPLE_TITLE + ':'),
        h('span', { class: 'body-s talk-example', 'data-level': id, style: 'white-space:pre-wrap' }, exampleOf(id, st.length))))));
    fill(lengths, W.LENGTHS.map(([id, label]) => radio(st.length === id, h('span', { class: 'label' }, label), 'talk-length', () => { st.length = id; draw(); })));
    fill(often, W.OFTEN.map(([id, label]) => radio(st.often === id, h('span', { class: 'label' }, label), 'talk-often-c', () => { st.often = id; draw(); })));
    fill(msgs, ex.map(m => radio(st.msg === m.id, h('span', { class: 'caption' }, m.label), 'talk-msg', () => { st.msg = m.id; draw(); })));
  }
  const err = h('p', { class: 'err-line', role: 'status' });
  const save = Button(W.SAVE, { variant: 'primary', onClick: async () => {
    err.textContent = '';
    try { const r = await post('/settings/talk', { level: st.level, length: st.length, often: st.often }); app.toast(W.SAVED); d.picked = true; d.prefs = r.prefs || d.prefs; fill(note, noteText()); }
    catch (e) { err.textContent = W.NOT_SAVED + ': ' + (e && e.message ? e.message : 'try again'); }
  } });
  const noteText = () => !d.picked ? W.NOT_PICKED : d.prefs.check === 'live' ? W.CHECK_LIVE + ' ' + W.checksLine(d.checks) : d.prefs.check === 'shadow' ? W.CHECK_SHADOW + ' ' + W.shadowLine(d.checks) : '';
  const note = h('p', { class: 'body-s muted talk-note', style: 'max-width:720px' }, noteText());
  draw();
  fill(host,
    Block({ id: 'level', title: W.LEVEL_TITLE }, h('div', { class: 'stack-8' }, h('span', { class: 'caption muted' }, W.EXAMPLE_PICK), msgs), levels),
    Block({ id: 'length', title: W.LENGTH_TITLE }, lengths),
    Block({ id: 'often', title: W.OFTEN_TITLE }, often),
    h('div', { class: 'stack-8' }, note, h('div', { class: 'row-8' }, save), err));
}
