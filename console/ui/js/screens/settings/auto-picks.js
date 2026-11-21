// Settings › Models › Automatic picks (console/routing.js: /api/routing/scoped, /api/models/routable; docs/ROUTING.md
// "Scoped routing"), in words a non-technical owner follows: whether each job goes to a model that has shown it can do
// that kind of work at that difficulty, picking the quickest one that uses the least of its own allowance (On / Off),
// and, per model, whether it "Can be picked automatically". A model switched off can still be given to someone on
// purpose. Every change runs company/tools/routing.js or models.js as the owner, which checks and records it. Model ids
// and the proven levels sit only under "Technical details (for the crew)".
import { h, fill, Button, errLine, humanError, Setting, Details, empty } from '../../ui.js';
import { api, post } from '../../api.js';

const KIND_SAY = { 1: 'looking things up', 2: 'pulling facts out', 3: 'writing', 4: 'planning', 5: 'numbers', 6: 'small code changes', 7: 'bigger code changes', 8: 'reviewing code', 9: 'using tools', 10: 'judgment calls' };
const DEPTH_SAY = { lookup: 'quick', simple: 'simple', standard: 'everyday', deep: 'hard' };
const TECH = 'Technical details (for the crew)';
const tech = (...lines) => Details(TECH, h('ul', { class: 'plain stack-4 caption mono-s routing-tech' }, lines.flat().filter(Boolean).map(l => h('li', null, l))));

// "Shown it can do: quick looking things up, everyday writing" — or a plain line when nothing is proven yet
export function provenLine(m) {
  const p = (m && m.proven) || [];
  if (!p.length) return 'Not tested yet, so it is not picked automatically until it has been tested.';
  return 'Has shown it can do: ' + p.slice(0, 4).map(x => (DEPTH_SAY[x.depth] || x.depth) + ' ' + (KIND_SAY[x.kind] || 'work of kind ' + x.kind)).join(', ') + (p.length > 4 ? ' and ' + (p.length - 4) + ' more' : '') + '.';
}

export function autoPicksSection(host, app) {
  let status = null, models = null, msg = null, busy = false;
  async function load() {
    try { status = await api('/routing'); models = await api('/models/routable'); } catch (e) { fill(host, errLine(e, 'Automatic picks')); return; }
    draw();
  }
  async function act(path, body, what) {
    busy = true; msg = null; draw();
    try { const r = await post(path, body); msg = { ok: true, text: r.changed === false ? 'It was already set that way, so nothing changed.' : what + '.' }; }
    catch (e) { msg = { ok: false, text: 'Not saved: ' + humanError(e) }; }
    busy = false; await load();
  }
  async function confirmed(o) { return !(app && app.confirmDialog) || app.confirmDialog(o); }
  function draw() {
    if (!status || !models) return;
    const on = !!(status.scoped && status.scoped.on);
    const list = (models.models || []).filter(m => m.allowed !== false || m.setting);
    const sw = Button(on ? 'Switch off' : 'Switch on', { size: 'sm', variant: on ? undefined : 'primary', disabled: busy, aria: 'Automatic picks: ' + (on ? 'switch off' : 'switch on'),
      onClick: async () => {
        if (on && !(await confirmed({ title: 'Switch off automatic picks?', body: 'Everyone goes back to their usual models for every job. You can switch it on again here at any time.', confirm: 'Switch off' }))) return;
        act('/routing/scoped', { on: !on }, on ? 'Automatic picks are off' : 'Automatic picks are on');
      } });
    const row = m => h('li', { class: 'between-c', style: 'gap:12px;flex-wrap:wrap', 'data-pair': m.pair },
      h('div', { class: 'stack-4' }, h('span', { class: 'body-s strong' }, m.model), h('span', { class: 'caption muted' }, provenLine(m))),
      h('label', { class: 'row-8', style: 'align-items:center' },
        h('input', { type: 'checkbox', checked: m.routable ? true : null, disabled: busy ? true : null, 'aria-label': 'Can be picked automatically: ' + m.model,
          onchange: e => act('/models/routable', { pair: m.pair, on: !!e.target.checked }, m.model + (e.target.checked ? ' can be picked automatically' : ' is no longer picked automatically')) }),
        h('span', { class: 'caption' }, 'Can be picked automatically')));
    fill(host,
      msg ? h('p', { class: msg.ok ? 'caption' : 'err-line', role: 'status' }, msg.text) : null,
      Setting({ id: 'routing-scoped', title: 'Pick the right model for each job', value: on ? 'On' : 'Off', valueTone: on ? 'online' : 'neutral',
        what: on ? 'Each job goes to a model that has shown it can do that kind of work at that difficulty. Among those, the crew picks the quickest one that uses the least of its own allowance. Easy work gets a light model; hard work gets a strong one. If a job comes back for rework, the next try goes to a stronger model. The CEO, and anyone whose models you set on purpose, keep their usual models.'
          : 'Everyone uses their usual models for every job.',
        flip: 'Only models open right now, inside your limits, and switched on below are picked. Everything is checked afterwards.', control: sw }),
      list.length ? h('ul', { class: 'plain stack-12 auto-picks' }, list.map(row)) : empty('No models to pick from yet.'),
      h('p', { class: 'caption muted' }, 'A model switched off here can still be given to someone on purpose.'),
      tech('scoped routing ' + (on ? 'on' : 'off') + (status.scoped && status.scoped.weights ? ' · weights ' + JSON.stringify(status.scoped.weights) : '') + (status.scoped && status.scoped.tieEpsilon != null ? ' · tie ' + status.scoped.tieEpsilon : ''),
        list.map(m => m.pair + ': ' + (m.routable ? 'routable' : 'not routable') + ' (' + m.why + ')' + (m.proven.length ? ' · proven ' + m.proven.map(p => 'kind ' + p.kind + ' ' + p.depth).join(', ') : ' · no proven depth'))));
  }
  load();
  return load;
}
