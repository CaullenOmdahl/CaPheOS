// Settings › Autonomy and guardrails (#/settings/autonomy[/presets|guardrails|gates|gate|changes]): the self-governance
// preset and per-decision levels, the guardrail switches, the owner gates and the external-action gate (was Controls ›
// Self-governance and Guardrails, and Governance). API: /api/governance, /api/guardrails, /api/external, /api/locked,
// /api/governance-log, /api/decision-models, /api/station/autonomy (shown only when the station has it).
import { h, fill, Button, Tag, errLine, empty, table, rel, Details, Setting, Block, humanError } from '../../ui.js';
import { api, post } from '../../api.js';
import * as events from '../../events.js';
import { rulingsSection, projectsSection } from './rulings.js';
// "20 November" (the date part as written, so the day never shifts with the viewer's time zone), as the owner's notice says it
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const untilWords = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m && MONTHS[Number(m[2]) - 1] ? Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1] + (Number(m[1]) !== new Date().getFullYear() ? ' ' + m[1] : '') : 'the date you set'; };

export const PRESET_WHAT = {
  'approve-everything': 'Every decision waits for you',
  'gate-money-people': 'You approve hires and money; the rest is reported',
  'gate-money': 'You approve money; the crew hires and reports',
  'autonomous': 'The crew hires and budgets itself; gates still hold',
};
const PRESET_UNLOCKS = {
  autonomous: 'The crew may open roles and hire, release crew members, set its own budgets and pacing, change models, tools and schedules, and act outside the company, all without asking you. The four owner gates (access, ownership, commitments, spend beyond the cap) and every guardrail still hold.',
};
const CAT_NAMES = { hiring: 'Hiring', release: 'Releasing someone', budget: 'Budgeting', spend: 'Spend inside the cap', models: 'Model changes',
  tools: 'Tool and policy changes', schedules: 'When the crew works', external: 'Acting outside', dashboard: 'Console pages', packs: 'Add-ons' };
const CAT_WHAT = { hiring: 'Opening a role and picking the hire.', release: 'Releasing or replacing a crew member.', budget: 'Setting the daily cap for AI that is paid by use, each member\'s share, and how the subscriptions are paced.',
  spend: 'New spend inside the approved cap, including a new paid tool.', models: 'Changing which AI a seat or routine runs on.', tools: 'Shared changes to tools, house rules and policies.',
  schedules: 'How often the crew picks up work and when each member\'s routines run.', external: 'Anything that leaves the company: messages, publishing, forms, network calls.',
  dashboard: 'Adding or changing panels and pages in this console.', packs: 'Approving an add-on, a new line of business. Installing one is always yours.' };
const CAT_SEAT = { hiring: 'People', release: 'People', budget: 'Finance', spend: 'Finance', models: 'People', tools: 'Tools', schedules: 'Tools', external: 'CEO', dashboard: 'Tools', packs: 'CEO' };
const LEVELS = [['auto', 'Crew decides'], ['notify', 'Decides, tells you'], ['triage', 'A tested check decides'], ['approve', 'You approve']];
export const GUARD_NAMES = { ownerGates: 'Owner gates', spendCap: 'Spend cap', externalActions: 'External actions', harnessSelfEdit: 'Review of the crew\'s own rules',
  defaultBranch: 'Main copy of the code is protected', secrets: 'Secrets', localComputer: 'Local computer', privilegedShell: 'Admin commands blocked', promptInjection: 'Suspicious instructions are flagged', halt: 'Halt' };
// what each guardrail does while on, and what switching it off unlocks
const GUARD_TEXT = {
  ownerGates: ['Access, ownership, commitments and spend beyond the cap always need you, whatever the levels above say.', 'The self-governance levels alone decide, so the crew could grant access or commit the company without you.'],
  spendCap: ['Pay-per-token spend stops at the daily cap and each member\'s share; subscriptions stop at their pacing line.', 'No cap holds a run: the crew can spend without limit.'],
  externalActions: ['Nothing leaves the company (a message, a post, an account, a form, a payment, a network call) without a recorded clearance.', 'The gate only logs: the crew can act outside the company freely.'],
  harnessSelfEdit: ['The crew cannot change its own rules: policies, gates, keys and routine prompts are watched and put back, and tool changes go through review.', 'The crew may edit its own rules, gates and tools without review. Changes are still logged.'],
  defaultBranch: ['No one pushes or merges to a repository\'s main branch without a named reviewer and test evidence.', 'The crew can push straight to main branches.'],
  secrets: ['The crew never reads, prints or copies keys and secrets.', 'The crew may read keys (they are still never shown in the owner channel).'],
  localComputer: ['The crew works only inside its workspace and the folders you allowed; screen and keyboard control stay off.', 'The crew gets the whole file system and control of the screen and keyboard.'],
  privilegedShell: ['Administrator (sudo) commands run only from an allowlist.', 'Any administrator command goes through.'],
  promptInjection: ['Routines and inputs that try to override instructions or smuggle data out are refused.', 'The tripwire only logs what it would have refused.'],
  halt: ['Soft and hard halt always work, and a halted company starts nothing.', null],
};
const CONFIRM = 'I understand there are no guardrails';
const POSTURE = [['wait', 'Wait', 'Ask before every action'], ['suggest', 'Suggest', 'Draft, then ask to apply'], ['small', 'Small jobs', 'Routine work alone; asks before bigger writes'], ['free', 'Free', 'Act, report after; gates still hold']];

export async function render(host, ctx) {
  const { app } = ctx;
  const presets = h('div'), guards = h('div'), gates = h('div'), ext = h('div'), posture = h('div'), dmodels = h('div'), changes = h('div'), rules = h('div'), projects = h('div'), delegs = h('div');
  fill(host,
    Block({ id: 'presets', title: 'Self-governance', lede: 'How often the crew asks before it acts. Pick a preset, then fine-tune any kind of decision.' }, presets),
    Block({ id: 'rules', title: 'Standing rules', lede: 'Your own rules, in your words. A question a rule covers is left to the crew instead of coming to you. The four owner gates below always come to you.' }, rules),
    Block({ id: 'projects', title: 'Projects to take over', lede: 'A product the crew asked to take over. Access is not ownership: only you approve it.' }, projects),
    Block({ id: 'guardrails', title: 'Guardrails', lede: 'Hard stops the crew cannot get past, whatever it decides. They start on; leave them on unless you know why.' }, guards),
    Block({ id: 'gates', title: 'Owner gates', lede: 'Four decisions that are always yours while the Owner gates guardrail is on.' }, gates),
    Block({ id: 'gate', title: 'External-action gate', lede: 'Every message, post, account, form, payment or network call that leaves the company needs a clearance naming you or the CEO. The default is no.' }, ext),
    posture, dmodels, delegs,
    Block({ id: 'changes', title: 'Recent changes', lede: 'Every change to self-governance, newest first.' }, changes));
  const act = async (path, b, okMsg) => {
    try { const r = await post(path, b); app.toast(okMsg || 'Saved.'); return r; }
    catch (e) { app.toast('Not saved: ' + humanError(e), true); return null; }
    finally { load(); }
  };

  function drawPresets(d) {
    const list = d.presets || Object.keys(PRESET_WHAT).map(id => ({ id, label: id }));
    const cur = list.find(p => p.id === d.preset);
    const choose = async p => {
      if (p.id === d.preset) return;
      if (PRESET_UNLOCKS[p.id] && !(await app.confirmDialog({ title: 'Switch to ' + p.label + '?', body: PRESET_UNLOCKS[p.id], confirm: 'Switch to ' + p.label, danger: true }))) return;
      act('/governance/preset', { preset: p.id }, 'Self-governance: ' + p.label + '.');
    };
    fill(presets,
      h('p', { class: 'body-s' }, 'Now: ', h('strong', { class: 'strong' }, cur ? cur.label : 'Custom'), ' — ', cur ? PRESET_WHAT[cur.id] || '' : 'set per decision below', '.'),
      h('div', { role: 'radiogroup', 'aria-label': 'Self-governance preset', class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(min(190px,100%),1fr));gap:10px' },
        list.map(p => h('button', { type: 'button', role: 'radio', 'aria-checked': p.id === d.preset ? 'true' : 'false', class: 'choice', onclick: () => choose(p) },
          h('span', { class: 'label' }, p.label), h('span', { class: 'caption' }, PRESET_WHAT[p.id] || ''))),
        !cur ? h('div', { class: 'choice', 'aria-checked': 'true', role: 'radio' }, h('span', { class: 'label' }, 'Custom'), h('span', { class: 'caption' }, 'Set per decision below')) : null),
      h('p', { class: 'caption muted' }, 'Picking a preset resets every decision below to that preset. Changing one decision makes the preset Custom.'),
      table(['Decision', 'Usually decided by'].concat(LEVELS.map(l => l[1])),
        (d.categories || []).map(c => h('tr', null,
          h('th', { scope: 'row' }, h('span', { class: 'label strong', style: 'display:block' }, CAT_NAMES[c.category] || c.category), h('span', { class: 'caption muted' }, CAT_WHAT[c.category] || '')),
          h('td', { class: 'muted' }, CAT_SEAT[c.category] || '—'),
          LEVELS.map(([l, name]) => l === 'triage' && (d.fixed || []).some(f => f.category === c.category) ? h('td', { class: 'subtle' }, '—') : h('td', null, h('button', { type: 'button', class: 'level-btn', 'aria-pressed': c.level === l ? 'true' : 'false', 'aria-label': (CAT_NAMES[c.category] || c.category) + ': ' + name,
            onclick: () => c.level !== l && act('/governance/set', { category: c.category, level: l }, (CAT_NAMES[c.category] || c.category) + ': ' + name.toLowerCase() + '.') }, c.level === l ? '●' : '○'))))), { minWidth: 760 }),
      h('p', { class: 'caption muted' }, '“A tested check decides” lets a tested rule decide the routine cases and send the rest to you.'));
  }

  function drawGuards(d) {
    const list = d.guards || [];
    const off = list.filter(g => !g.on);
    const flip = async g => {
      const name = GUARD_NAMES[g.name] || g.name, t = GUARD_TEXT[g.name] || [];
      if (g.on) {
        const ok = await app.confirmDialog({ title: 'Switch off ' + name + '?', danger: true, confirm: 'Switch off',
          body: 'This unlocks: ' + (t[1] || offPart(g.blocks) || 'this stop no longer holds.') + (g.name === 'harnessSelfEdit' ? ' Only do this while you are changing the rules yourself, and switch it back on after.' : '') });
        if (!ok) return;
      }
      act('/guardrails/set', { name: g.name, on: !g.on, why: g.on ? 'owner, from the console' : undefined }, name + (g.on ? ' off.' : ' on.'));
    };
    fill(guards,
      off.length ? h('div', { role: 'alert', class: 'alertbox', style: 'background:var(--status-danger-tint)' },
        h('span', { class: 'label' }, off.length + (off.length === 1 ? ' guardrail is off.' : ' guardrails are off.') + ' ' + (d.sandbox ? 'You marked this station as a throwaway container.' : 'This station is not marked as a throwaway container.'))) : null,
      h('div', { class: 'stack-10' }, list.map(g => {
        const name = GUARD_NAMES[g.name] || g.name, t = GUARD_TEXT[g.name] || [onPart(g.blocks), offPart(g.blocks)];
        return Setting({ id: 'set-guard-' + g.name, title: name, value: g.fixed ? 'Always on' : g.on ? 'On' : 'Off', valueTone: g.on ? 'online' : 'danger',
          what: t[0] || onPart(g.blocks),
          flip: g.fixed ? 'This one cannot be switched off.' : g.on ? 'If you switch it off: ' + (t[1] || offPart(g.blocks)) : 'Off now. Switch it on to bring the stop back.',
          extra: [g.name === 'harnessSelfEdit' && locked ? h('p', { class: 'caption muted' }, locked.summary) : null, g.note ? Details('Details', h('p', { class: 'caption' }, g.note), h('p', { class: 'caption mono-s' }, (g.enforcedIn || []).join(' · '))) : (g.enforcedIn || []).length ? Details('Details', h('p', { class: 'caption' }, String(g.blocks || '')), h('p', { class: 'caption mono-s' }, g.enforcedIn.join(' · '))) : null],
          control: h('button', { type: 'button', role: 'switch', class: 'switch', 'aria-checked': g.on ? 'true' : 'false', 'aria-label': name, disabled: g.fixed, onclick: () => flip(g) }, h('span', { class: 'knob' })) });
      })),
      Setting({ id: 'set-sandbox', title: 'This station runs in a throwaway container or VM', value: d.sandbox ? 'Marked' : 'Not marked', valueTone: d.sandbox ? 'warning' : 'neutral',
        what: 'Your statement, not a setting: it changes nothing on its own. It records that switching guardrails off here would hurt nothing you care about.',
        flip: d.sandbox ? 'Unmark it if this is your own computer.' : 'Mark it only on a machine you could throw away.',
        control: h('button', { type: 'button', role: 'switch', class: 'switch', 'aria-checked': d.sandbox ? 'true' : 'false', 'aria-label': 'Throwaway station', onclick: () => act('/guardrails/sandbox', { on: !d.sandbox }, d.sandbox ? 'Unmarked.' : 'Marked as a throwaway container.') }, h('span', { class: 'knob' })) }),
      h('div', { class: 'row-8' },
        off.length ? Button('Switch every guardrail on', { variant: 'secondary', size: 'sm', onClick: () => act('/guardrails/all', { on: true }, 'All guardrails on.') }) : null,
        Button('Run with no guardrails…', { variant: 'ghost', size: 'sm', onClick: async () => {
          const ok = await app.confirmDialog({ title: 'Run with no guardrails?', danger: true, confirm: 'Switch everything off', typed: CONFIRM,
            body: 'This unlocks everything: no owner gates, no spend cap, no external-action gate, no harness review, pushes to main branches, reading keys, the whole computer, administrator commands and no injection tripwire. Only halt stays. Only do this on a machine you can throw away.' });
          if (ok) act('/guardrails/all', { on: false, confirm: CONFIRM }, 'All guardrails off.');
        } })));
  }

  function drawGates(d, g) {
    const og = (g && (g.guards || []).find(x => x.name === 'ownerGates')) || null;
    const on = og ? og.on : (d && d.ownerGatesGuardrail) !== 'off';
    const GATE = [['access', 'Access', 'Giving anyone, or any service, access to the company or its accounts.'], ['ownership', 'Ownership', 'Who owns the company, a project or its work.'],
      ['commitment', 'Commitments', 'Signing up the company to anything binding: a contract, a subscription, a promise to someone outside.'], ['spendBeyondCap', 'Spend beyond the cap', 'Any spend above the daily cap you set.']];
    fill(gates, h('ul', { class: 'plain' }, GATE.map(([, name, what]) => h('li', { class: 'sys-row', style: 'align-items:flex-start' },
      h('span', { class: 'stack-4' }, h('span', { class: 'strong' }, name), h('span', { class: 'caption muted' }, what)),
      Tag(on ? 'Always you' : 'Levels decide', { variant: 'status', status: on ? 'online' : 'danger' })))),
      h('p', { class: 'caption muted' }, on ? 'These stay yours in every preset. Switching off the Owner gates guardrail above is the only way to loosen them.' : 'The Owner gates guardrail is off: the levels above decide these too.'));
  }

  async function drawExternal() {
    let d; try { d = await api('/external'); } catch (e) { return fill(ext, errLine(e, 'External-action gate')); }
    const rows = Array.isArray(d.rows) ? d.rows : Array.isArray(d.clearances) ? d.clearances : Array.isArray(d.items) ? d.items : null;
    const n = rows ? rows.length : d.count != null ? d.count : null;
    fill(ext,
      h('p', { class: 'body-s' }, n == null ? 'Clearances are recorded.' : n === 0 ? 'No clearances: nothing may leave the company.' : n + (n === 1 ? ' clearance' : ' clearances') + ' on record.'),
      rows && rows.length ? h('ul', { class: 'plain' }, rows.slice(0, 20).map(c => h('li', { class: 'sys-row', style: 'align-items:flex-start' },
        h('span', { class: 'stack-4', style: 'min-width:0' }, h('span', { class: 'strong' }, plainCategory(c.category || c.cat) + (c.target ? ': ' + hostOf(c.target) : '')),
          h('span', { class: 'caption muted' }, [c.clearedBy || c.by ? 'cleared by ' + (c.clearedBy || c.by) : null, c.until ? 'until ' + String(c.until).slice(0, 10) : null].filter(Boolean).join(' · '))),
        Tag(c.status || 'Valid', { variant: 'soft' })))) : null,
      Details('Details', h('pre', { class: 'pre mono-s' }, d.text || JSON.stringify(rows || d, null, 1))));
  }

  async function drawPosture() {
    // read-only, and only when the station reports one (most do not)
    try {
      const d = await api('/station/autonomy');
      const cur = String(d.posture || d.mode || d.level || (d.autonomy && (d.autonomy.posture || d.autonomy.mode)) || '').toLowerCase();
      if (!cur) return fill(posture);
      fill(posture, Block({ id: 'posture', title: 'How freely a run may act', lede: 'How freely the system the crew runs on lets a run act before asking. Shown from the station; it is changed on the station.' },
        h('div', { role: 'radiogroup', 'aria-label': 'How freely a run may act', class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(min(170px,100%),1fr));gap:10px' },
          POSTURE.map(([id, name, what]) => h('div', { role: 'radio', 'aria-checked': cur.startsWith(id) ? 'true' : 'false', 'aria-disabled': 'true', class: 'choice', style: 'min-height:72px;cursor:default' },
            h('span', { class: 'label' }, name), h('span', { class: 'caption' }, what))))));
    } catch (_) { fill(posture); }
  }

  async function drawDecisionModels() {
    let d; try { d = await api('/decision-models'); } catch (_) { return fill(dmodels); }
    const rows = d.models || [];
    if (!rows.length) return fill(dmodels);
    // On / Practice: the owner turns a tested check on or back to practice here (POST /api/decision-models/:id/mode)
    const setMode = async (m, mode) => {
      try { await post('/decision-models/' + encodeURIComponent(m.id) + '/mode', { mode }); app.toast((m.title || 'The rule') + (mode === 'live' ? ' is on.' : ' is back in practice mode.')); }
      catch (e) { app.toast('Not changed: ' + humanError(e), true); }
      drawDecisionModels();
    };
    fill(dmodels, Block({ id: 'decision-models', title: 'Decision rules', lede: 'Tested rules the company runs instead of asking an AI. In practice mode a rule only notes what it would do, and you are still asked.' },
      table(['Rule', 'Mode', 'Cases tested', 'Times used', 'Last used', ''], rows.map(m => h('tr', null,
        h('th', { scope: 'row', class: 'label strong' }, m.title || m.id),
        h('td', null, m.valid === false ? Tag('Broken', { variant: 'status', status: 'danger' }) : Tag(m.mode === 'live' ? 'On' : 'Practice', { variant: 'status', status: m.mode === 'live' ? 'online' : 'neutral' })),
        h('td', { class: 'num' }, String(m.cases || 0)), h('td', { class: 'num' }, String(m.evaluations || 0)),
        h('td', { class: 'caption muted' }, m.lastAt ? rel(m.lastAt) : '—'),
        h('td', null, m.valid === false ? null : m.mode === 'live' ? Button('Back to practice', { variant: 'ghost', size: 'sm', onClick: () => setMode(m, 'shadow') }) : Button('Turn on', { variant: 'secondary', size: 'sm', onClick: () => setMode(m, 'live') })))), { minWidth: 640 }),
      Details('Details', h('p', { class: 'caption' }, 'Turning a rule on uses its newest tested version; its test cases must pass first. Thresholds are set by the crew member who looks after risk, and shown here.'),
        h('ul', { class: 'plain caption mono-s' }, rows.map(m => h('li', null, m.id + ' v' + (m.active || '?') + ' · ' + Object.entries(m.params || {}).map(([k, v]) => k + ' ' + v).join(', ')))))));
  }

  // the owner's delegations: who may answer some of their questions for them, until when, and taking it back
  async function drawDelegations() {
    let d; try { d = await api('/delegations'); } catch (_) { return fill(delegs); }
    const act = (d.delegations || []).filter(x => x.active);
    if (!act.length) return fill(delegs);
    const back = async x => {
      try { await post('/delegations/' + encodeURIComponent(x.id) + '/revoke', {}); app.toast(x.to + ' no longer answers for you.'); }
      catch (e) { app.toast('Not changed: ' + humanError(e), true); }
      drawDelegations();
    };
    fill(delegs, Block({ id: 'delegations', title: 'Permission to answer for you', lede: 'Someone you named answers some of your questions while you are away. Their answers count as yours until the date shown.' },
      h('ul', { class: 'plain' }, act.map(x => h('li', { class: 'sys-row', style: 'align-items:flex-start' },
        h('span', { class: 'stack-4' }, h('span', { class: 'strong' }, x.to), h('span', { class: 'caption muted' }, (x.categories || []).map(c => (CAT_NAMES[c] || c).toLowerCase()).join(', ') + ' · until ' + untilWords(x.until))),
        Button('Take it back', { variant: 'secondary', size: 'sm', onClick: () => back(x) }))))));
  }

  async function drawChanges() {
    let d; try { d = await api('/governance-log'); } catch (e) { return fill(changes, errLine(e, 'Recent changes')); }
    const ent = (d.entries || []).slice().reverse().slice(0, 12);
    const say = x => {
      const cat = CAT_NAMES[x.category] || x.category, lv = (LEVELS.find(l => l[0] === (x.to || x.level)) || [])[1];
      if (x.event === 'preset' || x.op === 'preset') return 'Preset set to ' + (Object.keys(PRESET_WHAT).includes(x.preset) ? x.preset.replace(/-/g, ' ') : x.preset || 'custom');
      if (cat && lv) return cat + ': ' + lv.toLowerCase();
      return [x.event || x.op, cat, x.from && x.to ? x.from + ' → ' + x.to : x.level].filter(Boolean).join(' · ') || 'A change';
    };
    fill(changes, ent.length ? h('ul', { class: 'plain' }, ent.map(x => h('li', { class: 'sys-row' }, h('span', { class: 'strong' }, say(x)), h('span', { class: 'caption muted', style: 'text-align:right' }, [x.by, x.at ? rel(x.at) : null].filter(Boolean).join(' · ')))))
      : h('p', { class: 'body-s muted' }, 'No changes recorded yet.'));
  }

  let locked = null;   // the locked-file watch behind Harness review: "watching N files, M changed"
  async function load() {
    const [gov, gr, lk] = await Promise.allSettled([api('/governance'), api('/guardrails'), api('/locked')]);
    if (lk.status === 'fulfilled' && lk.value && lk.value.text) {
      const t = String(lk.value.text), n = (/watching (\d+) files/.exec(t) || [])[1], fl = (t.match(/^\s*flagged /gm) || []).length;
      locked = { summary: n ? 'Watching ' + n + ' protected files' + (fl ? '; ' + fl + ' changed without a record and reported to its owner.' : '; none changed without a record.') : 'Protected files are watched.' };
    }
    if (gov.status === 'fulfilled') drawPresets(gov.value); else fill(presets, errLine(gov.reason, 'Self-governance'));
    if (gr.status === 'fulfilled') drawGuards(gr.value); else fill(guards, errLine(gr.reason, 'Guardrails'));
    drawGates(gov.value, gr.value);
    drawExternal(); drawChanges();
  }
  load(); drawPosture(); drawDecisionModels(); drawDelegations();
  const reloadRules = rulingsSection(rules, app); projectsSection(projects, app);
  const off = events.on(['governance', 'guardrails'], load);
  const offR = events.on('rulings', reloadRules);
  return () => { off(); offR(); };
}
function onPart(b) { return String(b || '').split(' Off:')[0].replace(/\s*\([^)]*\.(js|json|py|sh)[^)]*\)/g, '').replace(/^./, c => c.toUpperCase()); }
function offPart(b) { return (String(b || '').split('Off:')[1] || '').trim(); }
function plainCategory(c) { return ({ message: 'Messages', publish: 'Publishing', account: 'Accounts', form: 'Forms', spend: 'Payments', payment: 'Payments', network: 'Network calls' })[c] || (c ? String(c).replace(/^./, x => x.toUpperCase()) : 'Clearance'); }
function hostOf(t) { try { return new URL(String(t).replace(/\*$/, '')).host; } catch (_) { return String(t).slice(0, 60); } }
