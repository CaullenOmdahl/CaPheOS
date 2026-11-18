// Settings › Models › Cheaper models (console/routing.js, docs/ROUTING.md), in words a non-technical owner follows:
// whether the crew may use a cheaper model for a piece of work where quality holds (Off / Watching only / On), whether
// routine work stays on lighter models, and each model trial the people function drafted ("Comparing three Claude models
// on coding work — 2 of 90 results so far"). The owner switches each one and starts, pauses, resumes or stops a trial;
// every change runs company/tools/routing.js as the owner, which checks and records it. Model ids, arms, the entry share,
// the exempt list and the routing log sit only under "Technical details (for the crew)". The crew sees the same through
// the `routing` page source (read only).
import { h, fill, Button, Tag, errLine, humanError, Setting, Details, empty, when as whenAt } from '../../ui.js';
import { personName } from '../../plain.js';
import { api, post } from '../../api.js';
import { heldLine, startBody, trialTitle, progressLine, waitingLine, technicalLines } from './routing-explain.js';

// the tool's modes off | shadow | live, said plainly
const MODE_SAY = {
  off: ['Off', 'neutral', 'The crew always uses its usual models.'],
  shadow: ['Watching only', 'warning', 'The crew notes which cheaper model it would pick, and keeps using its usual models. Use this to see what would change.'],
  live: ['On', 'online', 'The crew uses the cheaper choice for one piece of work at a time, and only a model it is allowed to use right now.'],
};
const CAPS_SAY = {
  off: ['Off', 'neutral', 'Everyone uses their usual models, whatever the work.'],
  shadow: ['Watching only', 'warning', 'The crew notes when routine work could have used a lighter model, and changes nothing.'],
  live: ['On', 'online', 'Routine work by crew members runs on lighter, cheaper models. Leads, the CEO and work marked as heavy keep their usual models.'],
};
const STATUS_SAY = { draft: ['Not started', 'neutral'], running: ['Running', 'online'], paused: ['Paused', 'warning'], done: ['Finished', 'neutral'] };
const TECH = 'Technical details (for the crew)';
const tech = (...lines) => Details(TECH, h('ul', { class: 'plain stack-4 caption mono-s routing-tech' }, lines.flat().filter(Boolean).map(l => h('li', null, l))));

export function routingSection(host, app) {
  let data = null, msg = null, busy = false;
  const tz = app && app.company && app.company.timezone;
  async function load() {
    try { data = await api('/routing'); } catch (e) { fill(host, errLine(e, 'Cheaper models')); return; }
    draw();
  }
  async function act(path, body, what) {
    busy = true; msg = null; draw();
    try { const r = await post(path, body || {}); msg = { ok: true, text: r.changed === false ? 'It was already set that way, so nothing changed.' : what + '.' }; }
    catch (e) { msg = { ok: false, text: 'Not saved: ' + humanError(e) }; }
    busy = false; await load();
  }
  async function confirmed(o) { return !(app && app.confirmDialog) || app.confirmDialog(o); }

  function modeControl(kind, current, label, say) {
    const buttons = ['off', 'shadow', 'live'].map(m => Button(say[m][0], { size: 'sm', variant: m === current ? 'primary' : undefined, disabled: busy || m === current,
      aria: label + ': ' + say[m][0], onClick: async () => {
        if (m === 'live' && !(await confirmed({ title: 'Switch on: ' + label.toLowerCase() + '?', body: say.live[2] + ' You can switch it back here at any time.', confirm: 'Switch it on' }))) return;
        act('/routing/' + kind, { mode: m }, label + ': ' + say[m][0].toLowerCase());
      } }));
    return h('div', { class: 'row-8', role: 'group', 'aria-label': label, style: 'flex-wrap:wrap' }, buttons);
  }

  function trialCard(t) {
    const [st, tone] = STATUS_SAY[t.status] || [t.status, 'neutral'];
    const shadow = data.mode !== 'live';
    const where = [].concat((t.scope && t.scope.departments || []).map(d => 'the ' + d + ' team'), (t.scope && t.scope.seats || []).map(personName)).join(', ');
    const btn = (op, label, say, ask) => Button(label, { size: 'sm', variant: op === 'start' || op === 'resume' ? 'primary' : undefined, disabled: busy, aria: label + ': ' + trialTitle(t),
      onClick: async () => { if (ask && !(await confirmed(ask))) return; act('/routing/trials/' + encodeURIComponent(t.id) + '/' + op, {}, say); } });
    const ops = t.status === 'draft' ? [btn('start', 'Start', 'The trial started', { title: 'Start this trial?', body: startBody(t, where, shadow), confirm: 'Start' })]
      : t.status === 'running' ? [btn('pause', 'Pause', 'The trial is paused'), btn('stop', 'Stop', 'The trial is stopped', { title: 'Stop this trial?', body: 'It finishes for good. What it learned so far is kept.', confirm: 'Stop', danger: true })]
      : t.status === 'paused' ? [btn('resume', 'Resume', 'The trial carries on'), btn('stop', 'Stop', 'The trial is stopped', { title: 'Stop this trial?', body: 'It finishes for good. What it learned so far is kept.', confirm: 'Stop', danger: true })] : [];
    const wait = waitingLine(t);
    return h('article', { class: 'card p20 stack-12 routing-trial', 'aria-label': trialTitle(t), 'data-trial': t.id },
      h('div', { class: 'between-c', style: 'flex-wrap:wrap;gap:8px' }, h('h3', { class: 'h4' }, trialTitle(t)), Tag(st, { variant: 'status', status: tone })),
      h('p', { class: 'body-s' }, progressLine(t) + (where ? ', in ' + where : '') + '.'),
      h('p', { class: 'caption muted' }, [t.createdBy ? 'Set up by ' + personName(t.createdBy) + '.' : null, t.startedAt ? 'Started ' + whenAt(Date.parse(t.startedAt), tz) + '.' : null].filter(Boolean).join(' ') || null),
      h('p', { class: 'caption' + (t.heldGuard && t.heldGuard.missing && t.heldGuard.missing.length ? ' err-line' : ' muted') }, heldLine(t)),
      wait ? h('p', { class: 'caption', role: 'status' }, wait) : null,
      t.progress && t.progress.enough ? h('p', { class: 'caption' }, 'Every model has enough results for a fair comparison.') : null,
      ops.length ? h('div', { class: 'row-8' }, ops) : null,
      tech(technicalLines(t)));
  }

  function draw() {
    if (!data) return;
    const m = MODE_SAY[data.mode] || MODE_SAY.off, c = CAPS_SAY[data.tierCaps && data.tierCaps.mode] || CAPS_SAY.off;
    const trials = (data.trials || []).filter(t => t.status !== 'done'), done = (data.trials || []).filter(t => t.status === 'done');
    const tc = data.tierCaps || {};
    fill(host,
      msg ? h('p', { class: msg.ok ? 'caption' : 'err-line', role: 'status' }, msg.text) : null,
      data.error ? h('p', { class: 'err-line', role: 'status' }, 'These settings cannot be read right now, so nothing can be changed until the crew puts them right.') : null,
      Setting({ id: 'routing-mode', title: 'Cheaper models where quality holds', value: m[0], valueTone: m[1], what: m[2], flip: 'Each team\'s preferred model for each kind of work, and the model trials below.', control: modeControl('mode', data.mode, 'Cheaper models', MODE_SAY) }),
      Setting({ id: 'routing-tiercaps', title: 'Keep routine work on lighter models', value: c[0], valueTone: c[1], what: c[2], flip: 'Saves money on everyday work; leads and the CEO are never moved.', control: modeControl('tiercaps', tc.mode, 'Routine work on lighter models', CAPS_SAY) }),
      h('h3', { class: 'h4' }, 'Model trials'),
      trials.length ? h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:16px' }, trials.map(trialCard))
        : empty('No model trials. The crew sets one up when it wants to compare models on real work; you start it here.'),
      done.length ? Details(done.length + ' finished ' + (done.length === 1 ? 'trial' : 'trials'), h('div', { class: 'stack-12' }, done.map(trialCard))) : null,
      tech('settings: mode ' + data.mode + ' · tier caps ' + (tc.mode || 'off') + (tc.allow && tc.allow.length ? ' · override allowlist ' + tc.allow.join(', ') : ' · override allowlist empty') +
        (tc.exemptFunctions && tc.exemptFunctions.length ? ' · exempt functions ' + tc.exemptFunctions.join(', ') : '') + (tc.exemptLeads ? ' · leads exempt' : '') + (data.source ? ' · source ' + data.source : ''),
        (data.log || []).slice(0, 20).map(r => (r.at ? whenAt(Number(r.at), tz) + ': ' : '') + (r.by || '?') + ' · ' + (r.op || '') + (r.trial ? ' ' + r.trial : '') + (r.from ? ' ' + r.from : '') + (r.to ? ' -> ' + r.to : '') + (r.why ? ' (' + r.why + ')' : ''))));
  }
  load();
  return load;
}
