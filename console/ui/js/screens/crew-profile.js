// Crew › <person> › Profile (#/crew/<seat>/profile; console/profile.js endpoints, docs/PROFILES.md): who they are, how
// they lean, what they believe and refuse, how they sound, who checks them, and what has happened to them here. The
// live preview (what they are told, built with no AI call) is pinned at the top while the owner edits; the history with
// "Go back to this version" sits beside the fields. Presets fill only the empty fields or replace everything (the owner picks). Every write goes through the tool.
import { h, fill, Button, Tag, errLine, humanError, when } from '../ui.js';
import { api, post } from '../api.js';

const SLIDERS = ['risk', 'pace', 'rigour', 'candour', 'independence'];
const LABELS = { risk: 'How much risk they take', pace: 'How fast they move', rigour: 'How thorough they are', candour: 'How bluntly they speak', independence: 'How much they decide on their own' };
const VOICES = [['composed', 'Composed'], ['warm', 'Warm'], ['blunt', 'Blunt'], ['dry', 'Dry'], ['upbeat', 'Upbeat']];
const LISTS = [['convictions', 'What they believe', 'One belief per line, earned from something that happened.'], ['willNotDo', 'What they won\'t do', 'One per line.'], ['unprompted', 'What they look after', 'What they take care of without being asked, one per line.']];
const LISTS2 = [['strengths', 'Strengths'], ['blindSpots', 'Blind spots'], ['habits', 'Habits'], ['flaws', 'Flaws']];
const OPS = { edit: 'Changed', undo: 'Went back', 'trial-start': 'Started a trial', 'trial-keep': 'Kept the trial', 'trial-end': 'Ended the trial', 'proposal-apply': 'Added a suggestion', 'sign-off override': 'The CEO overrode a sign-off' };
const clone = o => JSON.parse(JSON.stringify(o == null ? null : o));
const linesOf = t => String(t || '').split('\n').map(x => x.trim()).filter(Boolean);
const bold = t => String(t || '').split(/\*\*/).map((x, i) => i % 2 ? h('strong', {}, x) : x);

export function profilePanel(host, seatId) {
  let data = null, draft = null, presets = [], msg = null, busy = false, previewTimer = null, onEdit = () => {}, presetAsk = null;
  const prevHost = h('div', { class: 'stack-12' });

  async function load() {
    fill(host, h('p', { class: 'caption muted', 'aria-busy': 'true' }, 'Loading the profile…'));
    try {
      const [d, pr] = await Promise.all([api('/profile/' + encodeURIComponent(seatId)), api('/profile/presets').catch(() => ({ presets: [] }))]);
      data = d; presets = pr.presets || []; draft = d.profile ? clone(d.profile) : null;
    } catch (e) { fill(host, errLine(e, 'Profile')); return; }
    draw();
  }
  // the fields that differ from what is saved, as { pointer: value } (whole fields: the tool compares and records them)
  function changes() {
    const p = data.profile, out = {};
    for (const k of ['background', 'stake', 'personality']) if ((draft.identity[k] || '') !== (p.identity[k] || '')) out['/identity/' + k] = draft.identity[k] || '';
    if (draft.identity.archetype !== p.identity.archetype) out['/identity/archetype'] = draft.identity.archetype || '';
    for (const k of ['temperament', 'voice', 'examples', 'counterpart', 'relationships', 'convictions', 'willNotDo', 'unprompted', 'strengths', 'blindSpots', 'habits', 'flaws', 'reminder', 'ownerNotes'])
      if (JSON.stringify(draft[k] == null ? null : draft[k]) !== JSON.stringify(p[k] == null ? null : p[k])) out['/' + k] = draft[k] == null ? null : draft[k];
    return out;
  }
  const needsTrial = set => Object.keys(set).some(k => /^\/(temperament|counterpart)/.test(k));
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      try { const set = changes(); const r = await post('/profile/' + encodeURIComponent(seatId) + '/preview', Object.keys(set).length ? { set } : {}); drawPreview(r); } catch (_) {}
    }, 350);
  }
  async function act(fn, ok) {
    busy = true; msg = null; draw();
    try { await fn(); msg = { ok: true, text: ok }; busy = false; await load(); return; }
    catch (e) { msg = { ok: false, text: e && e.status === 409 ? humanError(e) : 'Not saved: ' + humanError(e) }; }
    busy = false; draw();
  }
  const name = () => String((draft && draft.identity.name) || data.name || seatId).split(/\s+/)[0];

  function drawPreview(pv) {
    pv = pv || data.preview || {};
    fill(prevHost,
      h('h3', { class: 'h4' }, 'What ' + name() + ' is told'),
      h('p', { class: 'caption muted' }, 'This is built from the profile, with no AI involved. It updates as you change things.'),
      pv.example ? h('div', { class: 'card stack-6', style: 'padding:12px', 'data-preview-example': '' },
        h('span', { class: 'caption muted' }, 'An example in ' + name() + '\'s own voice' + (pv.example.pushback ? ', pushing back' : '')),
        h('p', { class: 'body-s' }, pv.example.who + ': "' + pv.example.they + '"'), h('p', { class: 'body-s strong' }, name() + ': "' + pv.example.you + '"')) : null,
      h('details', {}, h('summary', { class: 'caption' }, 'The full text, in the crew\'s own words'), h('pre', { class: 'mono-s', style: 'white-space:pre-wrap;max-height:420px;overflow:auto', 'data-preview-block': '' }, (pv.ownerLevel && pv.ownerLevel !== 'technical' ? pv.blockOwner : pv.block) || '')));
  }
  const addedBy = (e, i) => { const v = ((data.experiences || [])[i] || {}).addedByName || (e.addedBy === 'owner' ? 'You' : ((data.crew || []).find(c => c.id === e.addedBy) || {}).name || 'the crew'); return v === 'You' ? 'you' : v; };
  function area(value, onInput, rows, label) { return h('textarea', { class: 'input', rows: rows || 3, 'aria-label': label, value: value || '', oninput: e => { onInput(e.target.value); onEdit(); } }); }
  function section(title, ...kids) { return h('section', { class: 'stack-8', 'data-section': title }, h('h3', { class: 'h4' }, title), kids); }

  function draw() {
    if (!data) return;
    const w = data.words || {}, pol = data.policy || {};
    if (!draft) {
      fill(host, h('div', { class: 'stack-12' }, h('p', { class: 'body-s' }, (data.name || 'This person') + ' has no full profile yet.'),
        Button(busy ? 'Building…' : 'Build it from their role description', { variant: 'primary', disabled: busy, onClick: () => act(() => post('/profile/' + encodeURIComponent(seatId) + '/migrate', {}), 'Profile built. Fill in what is still empty.') }),
        msg ? h('p', { class: msg.ok ? 'caption' : 'err-line' }, msg.text) : null));
      return;
    }
    const left = h('div', { class: 'stack-24', style: 'flex:2 1 420px;min-width:0' }), right = h('div', { class: 'stack-24', style: 'flex:1 1 300px;min-width:0' });
    const set = changes(), dirty = Object.keys(set).length > 0;
    // the trial banner, the company switch, the family note
    const top = [];
    if (w.trial) top.push(h('div', { class: 'card row-8', role: 'status', 'data-trial': '', style: 'padding:12px;flex-wrap:wrap;align-items:center' }, h('span', { class: 'body-s' }, w.trial.replace(/ Keep it · Go back now\.$/, '')),
      Button('Keep it', { size: 'sm', variant: 'primary', disabled: busy, onClick: () => act(() => post('/profile/' + encodeURIComponent(seatId) + '/trial/keep', {}), 'Kept.') }),
      Button('Go back now', { size: 'sm', disabled: busy, onClick: () => act(() => post('/profile/' + encodeURIComponent(seatId) + '/trial/stop', {}), 'Back to how they were.') })));
    if (pol.inject !== 'profile') top.push(h('div', { class: 'card stack-6', style: 'padding:12px', 'data-policy': '' }, h('p', { class: 'body-s' }, 'Profiles are kept here, but the crew still works from their role descriptions.'),
      Button('Use profiles for this company', { size: 'sm', disabled: busy, onClick: () => { if (confirm('From now on every crew member works from their profile. You can switch back here at any time.')) act(() => post('/profile/policy', { inject: 'profile' }), 'The crew now works from their profiles.'); } })));
    for (const f of w.family || []) top.push(h('p', { class: 'caption', 'data-family': '' }, f));
    // presets
    const presetRow = presets.length ? h('div', { class: 'stack-6' }, h('div', { class: 'row-8', style: 'flex-wrap:wrap', 'data-presets': '' }, h('span', { class: 'caption muted' }, 'Start from a preset:'), presets.map(pr => Button(pr.label, { size: 'sm', variant: presetAsk === pr ? 'primary' : 'ghost', onClick: () => { presetAsk = pr; draw(); } }))),
      presetAsk ? h('div', { class: 'card stack-6', role: 'group', 'aria-label': 'Use the preset', 'data-preset-ask': '', style: 'padding:12px' }, h('p', { class: 'body-s' }, 'Use "' + presetAsk.label + '" for ' + name() + '?'),
        h('div', { class: 'row-8', style: 'flex-wrap:wrap' },
          Button('Fill only empty fields', { size: 'sm', variant: 'primary', onClick: () => { const pr = presetAsk; presetAsk = null; applyPreset(pr, false); } }),
          Button('Replace everything', { size: 'sm', onClick: () => { const pr = presetAsk; presetAsk = null; applyPreset(pr, true); } }),
          Button('Cancel', { size: 'sm', variant: 'ghost', onClick: () => { presetAsk = null; draw(); } }))) : null) : null;
    const id = draft.identity;
    fill(left,
      top, presetRow,
      section('Who they are', h('p', { class: 'label strong' }, id.name || data.name), h('p', { class: 'body-s muted' }, id.title || ''), h('p', { class: 'caption muted' }, w.model || ''),
        h('label', { class: 'caption' }, 'Where they come from'), area(id.background, v => { id.background = v; }, 4, 'Where they come from'),
        h('label', { class: 'caption' }, 'Why they care how the company does'), area(id.stake, v => { id.stake = v; }, 2, 'Why they care')),
      section('Temperament', SLIDERS.map(k => {
        const s = (data.temperament.sliders || {})[k] || { values: [] }; const desc = h('span', { class: 'body-s', 'data-desc': k }, s.values[draft.temperament[k]] || '');
        return h('div', { class: 'stack-4' }, h('label', { class: 'caption muted', for: 'sl-' + k }, LABELS[k]),
          h('input', { type: 'range', min: '0', max: '4', step: '1', id: 'sl-' + k, value: String(draft.temperament[k]), 'aria-valuetext': s.values[draft.temperament[k]] || '', oninput: e => { draft.temperament[k] = Number(e.target.value); desc.textContent = s.values[draft.temperament[k]] || ''; e.target.setAttribute('aria-valuetext', desc.textContent); schedulePreview(); drawSave(); } }), desc);
      })),
      LISTS.map(([k, t, hint]) => section(t, h('p', { class: 'caption muted' }, hint), area((draft[k] || []).join('\n'), v => { draft[k] = linesOf(v); drawSave(); }, 4, t))),
      section('How they sound', h('div', { class: 'row-8', style: 'flex-wrap:wrap' }, VOICES.map(([v, l]) => Button(l, { size: 'sm', variant: draft.voice.preset === v ? 'primary' : 'ghost', onClick: () => { draft.voice.preset = v; draw(); schedulePreview(); } }))),
        h('label', { class: 'caption' }, 'In their own words'), area(draft.voice.words, v => { draft.voice.words = v; drawSave(); }, 3, 'How they sound'),
        h('label', { class: 'caption' }, 'How they talk to you'), area(draft.voice.toOwner, v => { draft.voice.toOwner = v; drawSave(); }, 2, 'How they talk to you')),
      section('Example exchanges', h('p', { class: 'caption muted' }, 'At least three, and at least one where they push back.'), (draft.examples || []).map((e, i) => exampleRow(e, i)),
        Button('Add an example', { size: 'sm', variant: 'ghost', onClick: () => { draft.examples = (draft.examples || []).concat([{ with: 'owner', they: '', you: '', pushback: false }]); draw(); } })),
      section('Who checks them', h('p', { class: 'body-s', 'data-counterpart': '' }, bold(w.counterpart || '')), w.checks ? h('p', { class: 'caption muted' }, w.checks) : null, counterpartPicker()),
      LISTS2.map(([k, t]) => section(t, area((draft[k] || []).join('\n'), v => { draft[k] = linesOf(v); drawSave(); }, 3, t))),
      section('Relationships', (draft.relationships || []).map((r, i) => h('div', { class: 'row-8', style: 'align-items:center' }, personSelect(r.seat, v => { r.seat = v; drawSave(); }, false),
        h('input', { class: 'input', value: r.note, 'aria-label': 'How they get on', oninput: e => { r.note = e.target.value; drawSave(); } }), Button('Remove', { size: 'sm', variant: 'ghost', onClick: () => { draft.relationships.splice(i, 1); draw(); } }))),
        (data.crew || []).length ? Button('Add a relationship', { size: 'sm', variant: 'ghost', onClick: () => { draft.relationships = (draft.relationships || []).concat([{ seat: data.crew[0].id, note: '' }]); draw(); } }) : null),
      section('Experiences', (draft.experiences || []).length ? h('ul', { class: 'plain stack-4' }, draft.experiences.map((e, i) => h('li', { class: 'body-s' }, e.text, h('span', { class: 'caption muted' }, ' · added by ' + addedBy(e, i) + (e.at ? ', ' + e.at : ''))))) : h('p', { class: 'caption muted' }, 'Nothing yet. The people team suggests additions after things happen.'),
        (w.proposals || []).map(pp => h('div', { class: 'card stack-6', style: 'padding:12px', 'data-proposal': pp.id }, h('p', { class: 'body-s' }, pp.text.replace(/ Add it · Not this one · Try it\.$/, '')),
          h('div', { class: 'row-8' }, Button('Add it', { size: 'sm', variant: 'primary', disabled: busy, onClick: () => act(() => post('/profile/proposals/' + pp.id + '/apply', {}), 'Added.') }),
            Button('Not this one', { size: 'sm', disabled: busy, onClick: () => act(() => post('/profile/proposals/' + pp.id + '/decline', {}), 'Left out.') }),
            Button('Try it', { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => act(() => post('/profile/proposals/' + pp.id + '/try', {}), 'Trying it.') }))))),
      section('Fixed rules', h('p', { class: 'caption muted' }, 'No profile can change these.'), h('ul', { class: 'plain stack-4' }, (w.boundaries || []).map(b => h('li', { class: 'body-s' }, b)))),
      section('Your notes', h('p', { class: 'caption muted' }, 'Only you see these; they are never shown to ' + name() + '.'), area(draft.ownerNotes, v => { draft.ownerNotes = v; drawSave(); }, 2, 'Your notes')));
    const saveHost = h('div', { class: 'stack-8', 'data-save': '' });
    function drawSave() {
      const s = changes(), n = Object.keys(s).length;
      const days = h('input', { type: 'number', min: '1', max: '60', value: '7', class: 'input', style: 'width:5em', 'aria-label': 'How many days to try it' });
      fill(saveHost,
        n ? h('p', { class: 'caption' }, needsTrial(s) ? 'A change to how ' + name() + ' leans or who checks them is tried first, then kept only if you say so.' : 'Ready to save.') : h('p', { class: 'caption muted' }, 'No changes yet.'),
        h('div', { class: 'row-8', style: 'flex-wrap:wrap;align-items:center' },
          !needsTrial(s) ? Button(busy ? 'Saving…' : 'Save changes', { variant: 'primary', disabled: busy || !n, onClick: () => act(() => post('/profile/' + encodeURIComponent(seatId), { set: s, base: data.profile.version }), 'Saved.') }) : null,
          h('span', { class: 'caption' }, 'Try this change for'), days, h('span', { class: 'caption' }, 'days'),
          Button('Try this change', { variant: needsTrial(s) ? 'primary' : 'secondary', disabled: busy || !n, onClick: () => act(() => post('/profile/' + encodeURIComponent(seatId) + '/try', { set: s, base: data.profile.version, days: Number(days.value) || 7 }), 'Trying it.') }),
          needsTrial(s) ? Button('Change it now, no trial', { variant: 'ghost', disabled: busy || !n, onClick: () => { if (confirm('Change ' + name() + ' now, without trying it first?')) act(() => post('/profile/' + encodeURIComponent(seatId), { set: s, base: data.profile.version, now: true }), 'Changed.'); } }) : null),
        msg ? h('p', { class: msg.ok ? 'caption' : 'err-line', role: 'status' }, msg.text) : null);
      schedulePreview();
    }
    const hist = h('section', { class: 'stack-8', 'data-history': '' }, h('h3', { class: 'h4' }, 'History'),
      (data.history || []).length ? h('ol', { class: 'plain stack-6' }, data.history.map(r => h('li', { class: 'stack-2' },
        h('span', { class: 'body-s' }, (OPS[r.op] || 'Changed') + ' · ' + r.by + (r.at ? ' · ' + when(r.at) : '')), r.why ? h('span', { class: 'caption muted' }, r.why) : null,
        r.version && r.version < data.profile.version && r.op !== 'sign-off override' ? Button('Go back to this version', { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => { if (confirm('Go back to how ' + name() + ' was at this point? You can undo this too.')) act(() => post('/profile/' + encodeURIComponent(seatId) + '/undo', { to: r.version }), 'Back to that version.'); } }) : null))) : h('p', { class: 'caption muted' }, 'No changes yet.'));
    fill(right, hist);
    // the live preview stays in view while the owner edits: pinned at the top of the panel (sticky), above the fields
    const pinned = h('div', { class: 'card', 'data-preview': '', style: 'position:sticky;top:0;z-index:2;padding:12px;max-height:45vh;overflow:auto' }, prevHost);
    fill(host, h('div', { class: 'stack-16' }, pinned, h('div', { style: 'display:flex;flex-wrap:wrap;gap:32px' }, h('div', { class: 'stack-16', style: 'flex:2 1 420px;min-width:0' }, left, saveHost), right)));
    onEdit = drawSave;
    drawSave(); drawPreview();
  }
  function personSelect(value, onPick, withOwner) {
    const opts = (withOwner ? [{ id: 'owner', name: 'You' }] : []).concat(data.crew || []);
    return h('select', { class: 'select', 'aria-label': 'Who', onchange: e => { onPick(e.target.value); schedulePreview(); } }, opts.map(o => h('option', { value: o.id, selected: o.id === value }, o.name)));
  }
  function exampleRow(e, i) {
    return h('div', { class: 'card stack-6', style: 'padding:12px', 'data-example': String(i) },
      h('div', { class: 'row-8', style: 'align-items:center' }, h('span', { class: 'caption' }, 'With'), personSelect(e.with, v => { e.with = v; onEdit(); }, true),
        h('label', { class: 'caption row-4' }, h('input', { type: 'checkbox', checked: !!e.pushback, onchange: ev => { e.pushback = ev.target.checked; onEdit(); } }), 'pushes back'),
        Button('Remove', { size: 'sm', variant: 'ghost', onClick: () => { draft.examples.splice(i, 1); draw(); } })),
      h('input', { class: 'input', value: e.they, placeholder: 'What the other person says', 'aria-label': 'What the other person says', oninput: ev => { e.they = ev.target.value; onEdit(); } }),
      h('input', { class: 'input', value: e.you, placeholder: 'How ' + name() + ' answers', 'aria-label': 'How they answer', oninput: ev => { e.you = ev.target.value; onEdit(); } }));
  }
  function counterpartPicker() {
    const c = draft.counterpart || { seat: '', signOff: [], why: '' };
    const kinds = Object.entries(data.signoffKinds || {});
    const sel = h('select', { class: 'select', 'aria-label': 'Who checks them', onchange: e => { draft.counterpart = e.target.value ? Object.assign({}, c, { seat: e.target.value, signOff: c.signOff || [] }) : null; draw(); schedulePreview(); } },
      h('option', { value: '', selected: !c.seat }, 'Nobody'), (data.crew || []).map(o => h('option', { value: o.id, selected: o.id === c.seat }, o.name)));
    return h('div', { class: 'stack-6' }, sel, c.seat ? h('div', { class: 'stack-4' }, h('span', { class: 'caption muted' }, 'They have to agree before ' + name() + ' can:'),
      kinds.map(([k, words]) => h('label', { class: 'body-s row-4' }, h('input', { type: 'checkbox', checked: (c.signOff || []).includes(k), onchange: e => { const s = new Set(draft.counterpart.signOff || []); if (e.target.checked) s.add(k); else s.delete(k); draft.counterpart.signOff = kinds.map(x => x[0]).filter(x => s.has(x)); onEdit(); } }), words))) : null);
  }
  // who a preset example is with: the counterpart, a seat this one checks, its lead, its team, or the owner; never the owner
  // by default (a careful tester's "let's go straight to real money" is said by the eager seat, not by you)
  function presetWith(w) {
    const rel = data.relations || {}, crew = (data.crew || []).map(c => c.id), pick = a => (a || []).find(x => crew.includes(x)) || null;
    if (w === 'owner') return 'owner';
    if (w === 'counterpart') return (draft.counterpart && draft.counterpart.seat) || pick(rel.checks) || crew[0] || 'owner';
    if (w === 'eager') return pick(rel.checks) || (draft.counterpart && draft.counterpart.seat) || crew[0] || 'owner';
    if (w === 'lead') return (rel.manager && crew.includes(rel.manager) ? rel.manager : null) || crew[0] || 'owner';
    return pick(rel.reports) || (rel.manager && crew.includes(rel.manager) ? rel.manager : null) || crew[0] || 'owner';
  }
  function applyPreset(pr, all) {
    const empty = v => v == null || v === '' || (Array.isArray(v) && !v.length);
    if (all || empty(draft.identity.archetype)) draft.identity.archetype = pr.archetype;
    if (all) draft.temperament = Object.assign({}, draft.temperament, pr.temperament);
    if (all || empty(draft.voice.preset)) draft.voice.preset = pr.voicePreset;
    if (all || (draft.examples || []).length < 3) {
      const ex = pr.example || {}; const w = presetWith(ex.with);
      draft.examples = (all ? [] : draft.examples || []).concat([{ with: w, they: ex.they || '', you: ex.you || '', pushback: !!ex.pushback }]);
    }
    draw(); schedulePreview();
  }
  load();
}
