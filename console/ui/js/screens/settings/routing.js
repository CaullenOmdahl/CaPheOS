// Settings › Models › Routing (console/routing.js, docs/ROUTING.md): whether the router's choices (class routes, trials,
// tier caps) only get recorded or actually run, and each trial the people function drafted, with its arms, how many items
// each arm has had, and why it is paused. The owner switches modes and starts, pauses, resumes or stops a trial here;
// every change runs company/tools/routing.js as the owner, which checks and records it. The crew sees the same through
// the `routing` page source (read only).
import { h, fill, Button, Tag, errLine, humanError, Setting, Details, empty, when as whenAt } from '../../ui.js';
import { personName } from '../../plain.js';
import { api, post } from '../../api.js';

const MODE_SAY = {
  off: ['Off', 'neutral', 'Nothing is computed; every seat runs on its own model chain.'],
  shadow: ['Recording only', 'warning', 'The choice is written down on each wake, and the seat still runs on its own chain. Use this to see what would change.'],
  live: ['Live', 'online', 'The choice runs, for that one run only, and only on a model the seat may use right now.'],
};
const STATUS_SAY = { draft: ['Draft', 'neutral'], running: ['Running', 'online'], paused: ['Paused', 'warning'], done: ['Finished', 'neutral'] };
const PNAME = { 'claude-cli': 'Claude', custom: 'MiniMax', deepseek: 'DeepSeek' };
const armName = a => (PNAME[a.provider] || a.provider) + ' ' + a.model + (a.effort ? ' at ' + a.effort + ' effort' : '');

export function routingSection(host, app) {
  let data = null, msg = null, busy = false;
  const tz = app && app.company && app.company.timezone;
  async function load() {
    try { data = await api('/routing'); } catch (e) { fill(host, errLine(e, 'Routing')); return; }
    draw();
  }
  async function act(path, body, what) {
    busy = true; msg = null; draw();
    try { const r = await post(path, body || {}); msg = { ok: true, text: r.changed === false ? 'Nothing to change: ' + r.summary + '.' : what + '.' }; }
    catch (e) { msg = { ok: false, text: 'Not saved: ' + humanError(e) }; }
    busy = false; await load();
  }
  async function confirmed(o) { return !(app && app.confirmDialog) || app.confirmDialog(o); }

  function modeControl(kind, current, label) {
    const buttons = ['off', 'shadow', 'live'].map(m => Button(MODE_SAY[m][0], { size: 'sm', variant: m === current ? 'primary' : undefined, disabled: busy || m === current,
      aria: label + ': ' + MODE_SAY[m][0], onClick: async () => {
        if (m === 'live' && !(await confirmed({ title: 'Make ' + label.toLowerCase() + ' live?', body: 'From the next wake, the router\'s choice runs instead of the seat\'s own model, one run at a time, and only on a model the seat may use right now. You can switch back here at any time.', confirm: 'Make it live' }))) return;
        act('/routing/' + kind, { mode: m }, label + ' set to ' + MODE_SAY[m][0].toLowerCase());
      } }));
    return h('div', { class: 'row-8', role: 'group', 'aria-label': label, style: 'flex-wrap:wrap' }, buttons);
  }

  function trialCard(t) {
    const [st, tone] = STATUS_SAY[t.status] || [t.status, 'neutral'];
    const min = (t.progress && t.progress.minItemsPerArm) || t.minItemsPerArm || 0;
    const shadow = data.mode !== 'live';
    const arms = h('ul', { class: 'plain stack-8' }, (t.arms || []).map(a => {
      const n = a.items + a.shadowItems;
      return h('li', { class: 'between-c', style: 'flex-wrap:wrap;gap:8px' },
        h('span', { class: 'body-s' }, armName(a)),
        h('span', { class: 'caption muted mono' }, n + ' of ' + min + ' items' + (a.shadowItems && a.items ? ' (' + a.shadowItems + ' recorded only)' : a.shadowItems ? ' (recorded only)' : '')));
    }));
    const where = [].concat((t.scope && t.scope.departments || []).map(d => 'the ' + d + ' department'), (t.scope && t.scope.seats || []).map(personName)).join(', ');
    const btn = (op, label, say, ask) => Button(label, { size: 'sm', variant: op === 'start' || op === 'resume' ? 'primary' : undefined, disabled: busy, aria: label + ' trial ' + t.id,
      onClick: async () => { if (ask && !(await confirmed(ask))) return; act('/routing/trials/' + encodeURIComponent(t.id) + '/' + op, {}, say); } });
    const ops = t.status === 'draft' ? [btn('start', 'Start', 'Trial started', { title: 'Start this trial?', body: 'About ' + Math.round((t.entryShare || 0) * 100) + '% of wakes in ' + (where || 'its scope') + ' are split evenly between its ' + (t.arms || []).length + ' models' + (shadow ? '. Routing is not live, so this is only recorded until you switch routing live.' : '.'), confirm: 'Start' })]
      : t.status === 'running' ? [btn('pause', 'Pause', 'Trial paused'), btn('stop', 'Stop', 'Trial stopped', { title: 'Stop this trial?', body: 'It finishes for good: no more wakes go to its models. What it measured so far is kept.', confirm: 'Stop', danger: true })]
      : t.status === 'paused' ? [btn('resume', 'Resume', 'Trial resumed'), btn('stop', 'Stop', 'Trial stopped', { title: 'Stop this trial?', body: 'It finishes for good. What it measured so far is kept.', confirm: 'Stop', danger: true })] : [];
    return h('article', { class: 'card p20 stack-12', 'aria-label': 'Trial ' + t.id },
      h('div', { class: 'between-c', style: 'flex-wrap:wrap;gap:8px' }, h('h3', { class: 'h4' }, t.id), Tag(st, { variant: 'status', status: tone })),
      h('p', { class: 'caption muted' }, 'Compares models on ' + t.class + ' work in ' + (where || 'no scope') + ', about ' + Math.round((t.entryShare || 0) * 100) + '% of wakes there.' + (t.createdBy ? ' Drafted by ' + personName(t.createdBy) + '.' : '') + (t.startedAt ? ' Started ' + whenAt(Date.parse(t.startedAt), tz) + '.' : '')),
      arms,
      (t.reasons || []).length ? h('p', { class: 'caption', role: 'status' }, t.reasons.join('. ')) : null,
      t.progress && t.progress.enough ? h('p', { class: 'caption' }, 'Every model has enough items for a fair comparison.') : null,
      ops.length ? h('div', { class: 'row-8' }, ops) : null);
  }

  function draw() {
    if (!data) return;
    const m = MODE_SAY[data.mode] || MODE_SAY.off, c = MODE_SAY[data.tierCaps && data.tierCaps.mode] || MODE_SAY.off;
    const trials = (data.trials || []).filter(t => t.status !== 'done'), done = (data.trials || []).filter(t => t.status === 'done');
    fill(host,
      msg ? h('p', { class: msg.ok ? 'caption' : 'err-line', role: 'status' }, msg.text) : null,
      data.error ? h('p', { class: 'err-line', role: 'status' }, 'The routing settings file cannot be read, so nothing can be changed until the people function restores it.') : null,
      Setting({ id: 'routing-mode', title: 'Department routes and trials', value: m[0], valueTone: m[1], what: m[2], flip: 'Which model a department prefers for each kind of work, and the trials below.', control: modeControl('mode', data.mode, 'Routes and trials') }),
      Setting({ id: 'routing-tiercaps', title: 'Cheaper models for routine work', value: c[0], valueTone: c[1], what: c[2], flip: 'Crew members who are not a lead or the CEO use the lighter models on their chain, unless an item is marked as heavy work.', control: modeControl('tiercaps', data.tierCaps && data.tierCaps.mode, 'Tier caps') }),
      h('h3', { class: 'h4' }, 'Trials'),
      trials.length ? h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:16px' }, trials.map(trialCard))
        : empty('No trials. The people function drafts one when it wants to compare models on real work; you start it here.'),
      done.length ? Details(done.length + ' finished ' + (done.length === 1 ? 'trial' : 'trials'), h('div', { class: 'stack-12' }, done.map(trialCard))) : null,
      (data.log || []).length ? Details('Recent routing changes', h('ul', { class: 'plain stack-4' }, data.log.slice(0, 20).map(r =>
        h('li', { class: 'caption' }, (r.at ? whenAt(Number(r.at), tz) + ': ' : '') + personName(r.by) + ' · ' + String(r.op || '').replace(/-/g, ' ') + (r.trial ? ' ' + r.trial : '') + (r.to ? ' → ' + r.to : '') + (r.why ? ' (' + r.why + ')' : ''))))) : null);
  }
  load();
  return load;
}
